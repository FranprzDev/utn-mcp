import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
 * Baja todos los PDF de un curso y los une en un solo archivo con índice, guardado en exportsDir().
 * Lo que no es PDF o no se pudo bajar queda en `omitidos` con el motivo.
 */
export async function buildStudyPack(session: AulaSession, rawAddress: string) {
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
    for (const entry of pdfs) {
        try {
            const { bytes } = await fetchFile(session, downloadUrl(baseUrl, entry.file.fileurl), MAX_BYTES);
            inputs.push({ title: entry.file.filename, bytes });
            kept.push(entry);
        } catch (e) {
            omitted.push({ nombre: entry.file.filename, seccion: entry.section, motivo: (e as Error).message });
        }
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
