import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openDocument } from "../../shared/documents/index.js";
import { mergePdfs } from "../../shared/documents/merge.js";
import { exportsDir } from "../../shared/paths.js";
import { getCourseFiles, getUserCourses, type CourseFileEntry } from "../client/client.js";
import { MoodleError } from "../client/moodle-api.js";
import type { AulaSession } from "../client/session.js";
import { AddressLevel, parseAddress } from "./address.js";
import { downloadUrl, MAX_BYTES } from "./files.js";

const capFromEnv = (raw: string | undefined, fallback: number): number => {
    const n = Number(raw ?? fallback);
    return Number.isFinite(n) && n > 0 ? n : fallback;
};
const MAX_PACK_FILES = capFromEnv(process.env.UTN_MCP_PACK_MAX_FILES, 150);
const MAX_PACK_BYTES = capFromEnv(process.env.UTN_MCP_PACK_MAX_MB, 300) * 1024 * 1024;
const MAX_FINAL_MB = capFromEnv(process.env.UTN_MCP_PACK_MAX_FINAL_MB, 30);

const TOKEN_ERRORS = new Set(["invalidtoken", "expiredtoken"]);

export async function fetchPackFile(session: AulaSession, url: URL, maxBytes: number): Promise<Uint8Array> {
    let token = await session.getToken();
    const { baseUrl } = await session.getRegional();
    const aulaOrigin = new URL(baseUrl).origin;
    let current = url;
    let redirects = 0;

    for (let attempt = 0; ; attempt++) {
        const withToken = new URL(current);
        withToken.searchParams.set("token", token);

        let res: Response;
        try {
            res = await fetch(withToken, { signal: AbortSignal.timeout(60_000), redirect: "manual" });
        } catch (e) {
            throw new MoodleError(`No se pudo bajar el archivo: ${(e as Error).message}`);
        }

        if (res.status >= 300 && res.status < 400) {
            const location = res.headers.get("location");
            const next = location ? new URL(location, current) : null;
            redirects++;
            if (
                redirects > 3 ||
                !next ||
                next.username ||
                next.password ||
                next.origin !== aulaOrigin ||
                !next.pathname.includes("pluginfile.php")
            ) {
                throw new MoodleError(
                    `El aula redirigió la descarga a una dirección no permitida (${location ?? "sin destino"})`,
                );
            }
            current = next;
            continue;
        }

        const contentType = res.headers.get("content-type");
        if (contentType?.startsWith("application/json")) {
            const data = (await res.json()) as { error?: string; errorcode?: string };
            if (attempt === 0 && data.errorcode && TOKEN_ERRORS.has(data.errorcode)) {
                token = await session.refreshToken();
                continue;
            }
            throw new MoodleError(data.error ?? `HTTP ${res.status}`, data.errorcode);
        }
        if (!res.ok || !res.body) throw new MoodleError(`HTTP ${res.status} al bajar el archivo`);

        const tooBig = `El archivo pesa más de ${Math.round(maxBytes / 1024 / 1024)} MB; es demasiado para leerlo.`;
        if (Number(res.headers.get("content-length")) > maxBytes) {
            await res.body.cancel();
            throw new MoodleError(tooBig);
        }
        const chunks: Uint8Array[] = [];
        let total = 0;
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
            total += chunk.length;
            if (total > maxBytes) throw new MoodleError(tooBig);
            chunks.push(chunk);
        }
        const bytes = new Uint8Array(total);
        let i = 0;
        for (const part of chunks) {
            bytes.set(part, i);
            i += part.length;
        }
        return bytes;
    }
}

const isPdf = (e: CourseFileEntry) =>
    e.file.mimetype === "application/pdf" || e.file.filename.toLowerCase().endsWith(".pdf");

const safeFileName = (name: string) => name.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "");

const ADMIN_PATTERNS = [/cronograma/i, /programa anal[ií]tico/i, /bibliograf[ií]a/i, /formato de presentaci[oó]n/i, /presentaci[oó]n de los trabajos/i];
const ADMIN_SCAN_CHARS = 300;
const ADMIN_SCAN_PAGES = 2;

async function adminPattern(bytes: Uint8Array, filename: string): Promise<string | null> {
    try {
        const doc = await openDocument(bytes.slice(), filename);
        try {
            if (doc.format !== "pdf") return null;
            for (let page = 1; page <= Math.min(doc.total, ADMIN_SCAN_PAGES); page++) {
                const part = await doc.part(page);
                if (!("text" in part)) continue;
                const head = part.text.slice(0, ADMIN_SCAN_CHARS);
                const hit = ADMIN_PATTERNS.find((p) => p.test(head));
                if (hit) return hit.source;
            }
            return null;
        } finally {
            await doc.close();
        }
    } catch {
        return null;
    }
}

export interface StudyPackOptions {
    includeAll?: boolean;
    dryRun?: boolean;
    forceInclude?: string[];
    forceExclude?: string[];
}

export async function writePackFile(dir: string, courseName: string, bytes: Uint8Array): Promise<string> {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const base = join(dir, `${safeFileName(courseName)}-apuntes-${stamp}`);
    for (let n = 1; ; n++) {
        const candidate = n === 1 ? `${base}.pdf` : `${base}-${n}.pdf`;
        try {
            await writeFile(candidate, bytes, { flag: "wx" });
            return candidate;
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        }
    }
}

export async function buildStudyPack(session: AulaSession, rawAddress: string, options: StudyPackOptions = {}) {
    const { includeAll = false, dryRun = false, forceInclude = [], forceExclude = [] } = options;
    const address = parseAddress(rawAddress);
    if (address.level !== AddressLevel.Course) {
        throw new Error(
            `Para armar el pack pasá la dirección de un curso entero ("/curso/{courseId}", de aula_list_courses), no "${rawAddress}".`,
        );
    }

    const { baseUrl } = await session.getRegional();
    const course = (await getUserCourses(session)).find((c) => c.id === address.courseId);
    const entries = await getCourseFiles(session, address.courseId);

    const pdfs = entries.filter(isPdf);
    const omitted = entries
        .filter((e) => !isPdf(e))
        .map((e) => ({ nombre: e.file.filename, seccion: e.section, motivo: "no es un PDF" }));
    if (!pdfs.length) {
        throw new Error("El curso no tiene ningún PDF en sus secciones visibles.");
    }

    const capMotivo = `se alcanzó el tope del pack (${MAX_PACK_FILES} archivos / ${MAX_PACK_BYTES / 1024 / 1024} MB): se puede subir con UTN_MCP_PACK_MAX_FILES / UTN_MCP_PACK_MAX_MB`;
    const inputs: { title: string; bytes: Uint8Array }[] = [];
    const kept: CourseFileEntry[] = [];
    const seen = new Map<string, string>();
    let totalBytes = 0;
    for (const entry of pdfs) {
        const name = entry.file.filename;
        if (inputs.length >= MAX_PACK_FILES || totalBytes + (entry.file.filesize ?? 0) > MAX_PACK_BYTES) {
            omitted.push({
                nombre: name,
                seccion: entry.section,
                motivo: capMotivo,
            });
            continue;
        }
        let bytes: Uint8Array;
        try {
            bytes = await fetchPackFile(session, downloadUrl(baseUrl, entry.file.fileurl), MAX_BYTES);
        } catch (e) {
            omitted.push({ nombre: name, seccion: entry.section, motivo: (e as Error).message });
            continue;
        }
        if (forceExclude.includes(name)) {
            omitted.push({ nombre: name, seccion: entry.section, motivo: "excluido a pedido" });
            continue;
        }
        const hash = createHash("sha256").update(bytes).digest("hex");
        const original = seen.get(hash);
        if (original) {
            omitted.push({ nombre: name, seccion: entry.section, motivo: `es idéntico a "${original}"` });
            continue;
        }
        if (totalBytes + bytes.length > MAX_PACK_BYTES) {
            omitted.push({
                nombre: name,
                seccion: entry.section,
                motivo: capMotivo,
            });
            continue;
        }
        if (!includeAll && !forceInclude.includes(name)) {
            const pattern = await adminPattern(bytes, name);
            if (pattern) {
                omitted.push({
                    nombre: name,
                    seccion: entry.section,
                    motivo: `material administrativo, no de estudio (coincidencia: "${pattern}")`,
                });
                continue;
            }
        }
        seen.set(hash, name);
        inputs.push({ title: name, bytes });
        kept.push(entry);
        totalBytes += bytes.length;
    }

    const courseName = course?.shortname ?? `curso-${address.courseId}`;

    const known = new Set(pdfs.map((e) => e.file.filename));
    const avisos = [...forceInclude, ...forceExclude]
        .filter((n) => !known.has(n))
        .map((n) => `"${n}" no es el nombre de ningún PDF del curso`);

    const materialesDe = (list: { title: string }[], entries: CourseFileEntry[]) =>
        list.map((m, i) => ({ nombre: m.title, seccion: entries[i].section, modulo: entries[i].module }));

    if (dryRun) {
        return {
            propuesta: true,
            curso: course?.fullname ?? courseName,
            incluiria: materialesDe(inputs, kept),
            omitidos: omitted.length ? omitted : undefined,
            avisos: avisos.length ? avisos : undefined,
        };
    }

    const { bytes, pages, merged, skipped } = await mergePdfs(inputs, `Apuntes de ${course?.fullname ?? courseName}`);
    for (const s of skipped) {
        omitted.push({ nombre: kept[s.index].file.filename, seccion: kept[s.index].section, motivo: s.reason });
    }

    const dir = exportsDir();
    await mkdir(dir, { recursive: true });
    const maxFinalBytes = MAX_FINAL_MB * 1024 * 1024;
    if (bytes.length > maxFinalBytes) {
        const mb = Math.round((bytes.length / 1024 / 1024) * 10) / 10;
        throw new Error(
            `El PDF final pesa ${mb} MB, más del máximo (${MAX_FINAL_MB} MB): no se guardó. ` +
                "Opciones: excluir archivos con `excluir` (la propuesta de `solo_listar` muestra qué entra) " +
                "o, si el usuario acepta un PDF más pesado, subir el tope con UTN_MCP_PACK_MAX_FINAL_MB.",
        );
    }
    const path = await writePackFile(dir, courseName, bytes);

    return {
        archivo: path,
        curso: course?.fullname ?? courseName,
        paginas: pages,
        materiales: merged.map((m) => ({
            nombre: m.title,
            seccion: kept[m.index].section,
            modulo: kept[m.index].module,
            paginas: m.pages,
            empiezaEn: m.startPage,
        })),
        omitidos: omitted.length ? omitted : undefined,
        avisos: avisos.length ? avisos : undefined,
    };
}
