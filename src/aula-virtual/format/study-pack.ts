import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openDocument } from "../../shared/documents/index.js";
import { mergePdfs } from "../../shared/documents/merge.js";
import { exportsDir } from "../../shared/paths.js";
import { getCourseFiles, getUserCourses, type CourseFileEntry } from "../client/client.js";
import { fetchFile } from "../client/moodle-api.js";
import type { AulaSession } from "../client/session.js";
import { parseAddress } from "./address.js";
import { downloadUrl, MAX_BYTES } from "./files.js";

/**
 * Topes de tamaño por pack: pdf-lib junta todo el resultado en memoria, así que sin tope total un
 * curso enorme podría colgar la compu donde corre el servidor. Lo que queda afuera por un tope se
 * lista en `omitidos` con el motivo, para pedir el resto en otro pack.
 * Una variable de entorno con basura NO puede desactivar el tope: si no es un número válido,
 * vuelve al default.
 */
export const capFromEnv = (raw: string | undefined, fallback: number): number => {
    const n = Number(raw ?? fallback);
    return Number.isFinite(n) && n > 0 ? n : fallback;
};
const MAX_PACK_FILES = capFromEnv(process.env.UTN_MCP_PACK_MAX_FILES, 150);
const MAX_PACK_BYTES = capFromEnv(process.env.UTN_MCP_PACK_MAX_MB, 300) * 1024 * 1024;
/** Máximo del PDF final: si lo supera NO se guarda; se informa el peso y las opciones. */
const MAX_FINAL_MB = capFromEnv(process.env.UTN_MCP_PACK_MAX_FINAL_MB, 30);

const isPdf = (e: CourseFileEntry) =>
    e.file.mimetype === "application/pdf" || e.file.filename.toLowerCase().endsWith(".pdf");

/** Los caracteres que no sirven para un nombre de archivo se cambian por "-". */
const safeFileName = (name: string) => name.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "");

/**
 * Material de gestión de la cursada, no de estudio: se detecta por el texto de las primeras
 * páginas (solo al principio, para no falsos-positivos un apunte que mencione la palabra).
 */
const ADMIN_PATTERNS = [/cronograma/i, /programa anal[ií]tico/i, /bibliograf[ií]a/i, /formato de presentaci[oó]n/i, /presentaci[oó]n de los trabajos/i];
const ADMIN_SCAN_CHARS = 300;
const ADMIN_SCAN_PAGES = 2;

/**
 * El patrón con que el PDF parece material administrativo (cronograma, programa, bibliografía,
 * formato de entrega), o null si no lo parece. Se miran las primeras páginas (una portada de
 * logo no tapa el contenido). Un PDF escaneado o que no se puede leer NO se descarta: mejor
 * incluir uno de más que tirar material de estudio.
 */
export async function adminPattern(bytes: Uint8Array, filename: string): Promise<string | null> {
    try {
        // pdf.js toma posesión del buffer (lo transfiere a su worker): hay que pasarle una copia
        // o los bytes originales quedan inutilizables para el merge que viene después.
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
    /** Une absolutamente todo, incluido el material administrativo. */
    includeAll?: boolean;
    /** No une ni escribe nada: devuelve la propuesta de qué incluiría y qué omitiría. */
    dryRun?: boolean;
    /** Nombres de archivo a incluir aunque parezcan administrativos. */
    forceInclude?: string[];
    /** Nombres de archivo a dejar afuera a pedido. */
    forceExclude?: string[];
}

/**
 * Escribe el pack sin pisar packs anteriores: nombre con fecha-hora y, si ya existe (dos packs
 * en el mismo segundo), un sufijo -2, -3... La escritura es atómica por nombre (bandera "wx").
 */
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

/**
 * Baja los PDF de un curso y los une en un solo archivo con índice, guardado en exportsDir().
 * Por defecto deja afuera el material administrativo (cronogramas, programas, formatos de
 * entrega, bibliografías) y los duplicados exactos: el compilado es para estudiar.
 * Todo lo omitido queda listado en `omitidos` con el motivo (y la coincidencia, si fue por
 * clasificación). Con `dryRun` no genera el archivo: devuelve la propuesta para revisarla
 * antes, ajustable con `forceInclude` / `forceExclude` por nombre de archivo.
 */
export async function buildStudyPack(session: AulaSession, rawAddress: string, options: StudyPackOptions = {}) {
    const { includeAll = false, dryRun = false, forceInclude = [], forceExclude = [] } = options;
    const address = parseAddress(rawAddress);
    if (address.level !== "course") {
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

    const inputs: { title: string; bytes: Uint8Array }[] = [];
    const kept: CourseFileEntry[] = [];
    const seen = new Map<string, string>(); // hash -> nombre del primero con ese contenido
    let totalBytes = 0;
    for (const entry of pdfs) {
        const name = entry.file.filename;
        if (inputs.length >= MAX_PACK_FILES || totalBytes + (entry.file.filesize ?? 0) > MAX_PACK_BYTES) {
            omitted.push({
                nombre: name,
                seccion: entry.section,
                motivo: `se alcanzó el tope del pack (${MAX_PACK_FILES} archivos / ${MAX_PACK_BYTES / 1024 / 1024} MB): se puede subir con UTN_MCP_PACK_MAX_FILES / UTN_MCP_PACK_MAX_MB`,
            });
            continue;
        }
        let bytes: Uint8Array;
        try {
            ({ bytes } = await fetchFile(session, downloadUrl(baseUrl, entry.file.fileurl), MAX_BYTES));
        } catch (e) {
            omitted.push({ nombre: name, seccion: entry.section, motivo: (e as Error).message });
            continue;
        }
        // Excluir es por NOMBRE: si otra copia del mismo contenido tiene otro nombre, entra igual.
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
        // El tamaño real se conoce recién ahora (Moodle a veces no lo anuncia): tope post-descarga.
        if (totalBytes + bytes.length > MAX_PACK_BYTES) {
            omitted.push({
                nombre: name,
                seccion: entry.section,
                motivo: `se alcanzó el tope del pack (${MAX_PACK_FILES} archivos / ${MAX_PACK_BYTES / 1024 / 1024} MB): se puede subir con UTN_MCP_PACK_MAX_FILES / UTN_MCP_PACK_MAX_MB`,
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
        // El hash se registra solo para lo que ENTRA: un excluido no puede volver "duplicados" a los demás.
        seen.set(hash, name);
        inputs.push({ title: name, bytes });
        kept.push(entry);
        totalBytes += bytes.length;
    }

    const courseName = course?.shortname ?? `curso-${address.courseId}`;

    // Aviso por nombres pedidos que no existen en el curso: un typo no tiene que pasar en silencio.
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
