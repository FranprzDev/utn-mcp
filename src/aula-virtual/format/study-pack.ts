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

const isPdf = (e: CourseFileEntry) =>
    e.file.mimetype === "application/pdf" || e.file.filename.toLowerCase().endsWith(".pdf");

/** Los caracteres que no sirven para un nombre de archivo se cambian por "-". */
const safeFileName = (name: string) => name.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "");

/**
 * Material de gestión de la cursada, no de estudio: se detecta por el texto de la primera
 * página (solo al principio, para no falsos-positivos un apunte que mencione la palabra).
 */
const ADMIN_PATTERNS = [/cronograma/i, /programa anal[ií]tico/i, /bibliograf[ií]a/i, /formato de presentaci[oó]n/i, /presentaci[oó]n de los trabajos/i];
const ADMIN_SCAN_CHARS = 300;

/**
 * Si la primera página del PDF es material administrativo (cronograma, programa, bibliografía,
 * formato de entrega). Un PDF escaneado o que no se puede leer NO se descarta: mejor incluir
 * uno de más que tirar material de estudio.
 */
async function isAdminMaterial(bytes: Uint8Array, filename: string): Promise<boolean> {
    try {
        // pdf.js toma posesión del buffer (lo transfiere a su worker): hay que pasarle una copia
        // o los bytes originales quedan inutilizables para el merge que viene después.
        const doc = await openDocument(bytes.slice(), filename);
        try {
            if (doc.format !== "pdf") return false;
            const first = await doc.part(1);
            if (!("text" in first)) return false;
            const head = first.text.slice(0, ADMIN_SCAN_CHARS);
            return ADMIN_PATTERNS.some((p) => p.test(head));
        } finally {
            await doc.close();
        }
    } catch {
        return false;
    }
}

/**
 * Baja los PDF de un curso y los une en un solo archivo con índice, guardado en exportsDir().
 * Por defecto deja afuera el material administrativo (cronogramas, programas, formatos de
 * entrega, bibliografías) y los duplicados exactos: el compilado es para estudiar.
 * Todo lo omitido queda listado en `omitidos` con el motivo.
 */
export async function buildStudyPack(session: AulaSession, rawAddress: string, includeAll = false) {
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
    for (const entry of pdfs) {
        const name = entry.file.filename;
        let bytes: Uint8Array;
        try {
            ({ bytes } = await fetchFile(session, downloadUrl(baseUrl, entry.file.fileurl), MAX_BYTES));
        } catch (e) {
            omitted.push({ nombre: name, seccion: entry.section, motivo: (e as Error).message });
            continue;
        }
        const hash = createHash("sha256").update(bytes).digest("hex");
        const original = seen.get(hash);
        if (original) {
            omitted.push({ nombre: name, seccion: entry.section, motivo: `es idéntico a "${original}"` });
            continue;
        }
        seen.set(hash, name);
        if (!includeAll && (await isAdminMaterial(bytes, name))) {
            omitted.push({ nombre: name, seccion: entry.section, motivo: "material administrativo, no de estudio" });
            continue;
        }
        inputs.push({ title: name, bytes });
        kept.push(entry);
    }

    const courseName = course?.shortname ?? `curso-${address.courseId}`;
    const { bytes, pages, merged, skipped } = await mergePdfs(inputs, `Apuntes de ${course?.fullname ?? courseName}`);
    for (const s of skipped) {
        omitted.push({ nombre: kept[s.index].file.filename, seccion: kept[s.index].section, motivo: s.reason });
    }

    const dir = exportsDir();
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${safeFileName(courseName)}-apuntes.pdf`);
    await writeFile(path, bytes);

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
    };
}
