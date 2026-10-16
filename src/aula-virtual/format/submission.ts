import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { htmlToText, textToHtml } from "../../shared/html.js";
import {
    checkFiles,
    formatSize,
    type FileSource,
    type UploadedFile,
    type UploadInbox,
    type UploadLimits,
} from "../../shared/uploads.js";
import {
    getAssignments,
    getSubmissionStatus,
    getUnusedDraftItemId,
    removeSubmission,
    saveSubmission,
    submitForGrading,
} from "../client/client.js";
import { fetchFile, uploadDraftFiles } from "../client/moodle-api.js";
import type { AulaSession } from "../client/session.js";
import type { AssignSubmission, MoodleFile } from "../client/types.js";
import { viewSubmission } from "./activities.js";
import { parseAddress } from "./address.js";
import { userFacingUrl } from "./files.js";
import { findModule } from "./navigate.js";

/** El máximo por archivo que deja subir el aula (`usermaxuploadfilesize` del sitio, 20 MB). */
const SITE_MAX_BYTES = 20 * 1024 * 1024;

export interface SubmissionRequest {
    /** La lista final de archivos: rutas locales (solo STDIO) o la `url` de uno que ya está en la entrega. */
    files?: string[];
    /** Id de un link de subida (solo HTTP): sus archivos se suman a la lista. */
    upload?: string;
    /** Texto plano del modelo; reemplaza el texto en línea. */
    text?: string;
    /** Confirmar el envío si la tarea usa borradores. */
    send: boolean;
    acceptStatement: boolean;
}

/** La tarea con su configuración y el intento actual del usuario, o un error que dice por qué no. */
async function openAssignment(session: AulaSession, rawAddress: string) {
    const address = parseAddress(rawAddress);
    if (address.level !== "module") throw new Error(`"${rawAddress}" no es la dirección de un módulo.`);
    const { module } = await findModule(session, address.courseId, address.cmid);
    if (module.modname !== "assign") {
        throw new Error(`"${rawAddress}" es un módulo de tipo ${module.modname}; solo se entregan tareas (assign).`);
    }

    const [assignments, status] = await Promise.all([
        getAssignments(session, address.courseId),
        getSubmissionStatus(session, module.instance),
    ]);
    const assignment = assignments.find((a) => a.cmid === module.id);
    const attempt = status.lastattempt;
    if (!assignment || !attempt) throw new Error(`No se pudo leer la configuración de la tarea ${rawAddress}.`);

    const config = (plugin: string, name: string) =>
        assignment.configs.find((c) => c.subtype === "assignsubmission" && c.plugin === plugin && c.name === name)
            ?.value;
    const limits: UploadLimits = {
        maxFiles: Number(config("file", "maxfilesubmissions")) || undefined,
        maxBytes: Number(config("file", "maxsubmissionsizebytes")) || SITE_MAX_BYTES,
        extensions: extensions(config("file", "filetypeslist") || ""),
    };
    return {
        address,
        module,
        assignment,
        attempt,
        config,
        limits,
        acceptsFiles: config("file", "enabled") === "1",
        acceptsText: config("onlinetext", "enabled") === "1",
        submission: attempt.teamsubmission ?? attempt.submission,
    };
}

const CLOSED =
    "La tarea no acepta cambios: ya está enviada, venció, está bloqueada o todavía no abre. " +
    "Abrila con aula_open para ver el estado y las fechas.";

/** Abre un link para recibir los archivos de una entrega en modo HTTP, con los límites de la tarea. */
export async function createUploadLink(session: AulaSession, rawAddress: string, inbox: UploadInbox, owner: string) {
    const { module, attempt, acceptsFiles, limits } = await openAssignment(session, rawAddress);
    if (!acceptsFiles) throw new Error("Esta tarea no acepta archivos.");
    if (!attempt.canedit) throw new Error(CLOSED);

    const { id, url, expiresAt } = inbox.open(owner, `Entrega: ${module.name}`, limits);
    return {
        subida: id,
        url,
        vence: expiresAt,
        acepta: {
            maximo: limits.maxFiles,
            tamanioMaximo: limits.maxBytes,
            extensiones: limits.extensions?.join(", "),
        },
        conTerminal: `curl -F "archivos=@/ruta/al/archivo.pdf" ${url}`,
    };
}

/**
 * Deja la entrega con los archivos y el texto pedidos, y la envía si hace falta. Lo que no se pasa
 * se conserva: Moodle reemplaza cada plugin con lo que recibe, así que se le reenvía lo que ya tenía.
 */
export async function submitAssignment(
    session: AulaSession,
    rawAddress: string,
    request: SubmissionRequest,
    source: FileSource,
) {
    const { address, module, assignment, attempt, config, limits, acceptsFiles, acceptsText, submission } =
        await openAssignment(session, rawAddress);
    const usesDrafts = assignment.submissiondrafts === 1;
    const fileChanges = request.files !== undefined || request.upload !== undefined;
    const changes = fileChanges || request.text !== undefined;

    // Todo lo que se puede validar va antes de tocar nada, para no dejar la entrega a medias.
    if (!changes && !(usesDrafts && request.send)) {
        throw new Error("Pasá archivos, `texto` o los dos: no hay nada para entregar.");
    }
    if (changes && !attempt.canedit) throw new Error(CLOSED);
    if (fileChanges && !acceptsFiles) throw new Error("Esta tarea no acepta archivos.");
    if (request.text !== undefined && !acceptsText) throw new Error("Esta tarea no acepta texto en línea.");
    const confirm = usesDrafts && request.send;
    if (confirm && assignment.requiresubmissionstatement === 1 && !request.acceptStatement) {
        throw new Error(
            "Para enviarla hay que aceptar esta declaración: «" +
                htmlToText(assignment.submissionstatement) +
                "». Mostrásela al usuario y, si la acepta, volvé a llamar con `aceptoDeclaracion: true`.",
        );
    }

    if (changes) {
        const files = acceptsFiles ? await collectFiles(session, request, submittedFiles(submission), source) : [];
        checkFiles(files, limits);
        const text = acceptsText
            ? currentOrNewText(submission, request.text, Number(config("onlinetext", "wordlimit")))
            : null;

        if (!files.length && !htmlToText(text?.html)) {
            await removeSubmission(session, assignment.id);
        } else {
            await saveSubmission(session, assignment.id, {
                filesItemId: acceptsFiles
                    ? files.length
                        ? await uploadDraftFiles(session, files)
                        : await getUnusedDraftItemId(session)
                    : undefined,
                text: text ? { ...text, itemid: await getUnusedDraftItemId(session) } : undefined,
            });
        }
        if (request.upload && !source.local) source.inbox.close(request.upload);
    }

    if (confirm) await submitForGrading(session, assignment.id, request.acceptStatement);

    const after = await viewSubmission(session, address.courseId, module);
    return {
        direccion: rawAddress,
        estado: after.estado,
        // Con borradores y sin confirmar, lo subido no cuenta todavía.
        aviso:
            usesDrafts && !request.send && after.estado === "borrador"
                ? "Quedó como borrador: no cuenta como entregada hasta confirmar el envío."
                : undefined,
        archivos: after.archivos?.map(({ nombre, tamanio, url }) => ({ nombre, tamanio, url })),
        texto: after.texto,
    };
}

function submittedFiles(submission: AssignSubmission | undefined): MoodleFile[] {
    return (submission?.plugins ?? [])
        .filter((p) => p.type === "file")
        .flatMap((p) => p.fileareas?.flatMap((a) => a.files ?? []) ?? []);
}

/**
 * Junta los bytes de la lista final: los de `files` (o los que ya estaban, si no se pasa) más los de
 * la subida. Los que ya estaban hay que volver a subirlos porque el borrador reemplaza el área entera.
 */
async function collectFiles(
    session: AulaSession,
    request: SubmissionRequest,
    current: MoodleFile[],
    source: FileSource,
): Promise<UploadedFile[]> {
    const entries = request.files ?? current.map((f) => userFacingUrl(f.fileurl));
    const collected: UploadedFile[] = [];
    for (const entry of entries) {
        const existing = current.find((f) => userFacingUrl(f.fileurl) === entry || f.fileurl === entry);
        collected.push(
            existing
                ? {
                      name: existing.filename,
                      bytes: (await fetchFile(session, new URL(existing.fileurl), SITE_MAX_BYTES)).bytes,
                  }
                : await readLocal(entry, source),
        );
    }
    if (request.upload !== undefined) {
        if (source.local) throw new Error("`subida` es del modo HTTP; acá los archivos van como ruta en `archivos`.");
        collected.push(...source.inbox.take(request.upload, source.owner));
    }
    return collected;
}

async function readLocal(path: string, source: FileSource): Promise<UploadedFile> {
    if (/^https?:\/\//i.test(path)) {
        throw new Error(
            `"${path}" no es un archivo de esta entrega. Las URLs sirven solo para conservar archivos ` +
                "que ya están subidos (las `url` de `entrega.archivos` en aula_open).",
        );
    }
    if (!source.local) {
        throw new Error(
            `"${path}" no es un archivo de esta entrega, y este servidor no lee archivos de tu dispositivo: ` +
                "los nuevos se suben con aula_assign_upload_link y se pasan con `subida`.",
        );
    }
    if (!isAbsolute(path)) throw new Error(`Pasá la ruta absoluta del archivo; "${path}" es relativa.`);

    let size: number;
    try {
        const info = await stat(path);
        if (!info.isFile()) throw new Error(`"${path}" no es un archivo.`);
        size = info.size;
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`No existe el archivo "${path}".`);
        throw e;
    }
    // El límite de la tarea lo chequea checkFiles; esto solo evita cargar en memoria algo que no puede entrar.
    if (size > SITE_MAX_BYTES) {
        throw new Error(`"${basename(path)}" pesa ${formatSize(size)} y el aula acepta hasta ${formatSize(SITE_MAX_BYTES)} por archivo.`);
    }
    return { name: basename(path), bytes: new Uint8Array(await readFile(path)) };
}

/**
 * Moodle valida los tipos en el formulario web, no en el web service: si no lo chequeamos, un .docx
 * entra en una tarea que pide PDF. Los grupos de tipos ("document", "image") no se pueden resolver
 * sin la tabla de Moodle, así que con un grupo en la lista no se restringe.
 */
function extensions(types: string): string[] | undefined {
    const list = types
        .split(/[\s,;]+/)
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);
    return list.length && list.every((t) => t.startsWith(".")) ? list : undefined;
}

/** El texto nuevo en HTML, o el que ya estaba para no borrarlo al guardar solo archivos. */
function currentOrNewText(submission: AssignSubmission | undefined, text: string | undefined, wordLimit: number) {
    if (text === undefined) {
        const field = submission?.plugins
            ?.find((p) => p.type === "onlinetext")
            ?.editorfields?.find((e) => e.name === "onlinetext");
        return { html: field?.text ?? "", format: field?.format ?? 1 };
    }
    const words = text.split(/\s+/).filter(Boolean).length;
    if (wordLimit && words > wordLimit) {
        throw new Error(`El texto tiene ${words} palabras y la tarea acepta hasta ${wordLimit}.`);
    }
    return { html: text.trim() ? textToHtml(text) : "", format: 1 };
}
