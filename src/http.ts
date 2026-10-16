import express, { type Request as ExpressRequest, type RequestHandler, type Response as ExpressResponse } from "express";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import {
    bearerAuthChallengeResponse,
    createMcpHandler,
    OAuthError,
    OAuthErrorCode,
    verifyBearerToken,
    type AuthInfo,
    type McpServerFactory,
    type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { logger } from "./shared/logger.js";
import type { SessionStore } from "./shared/store/session-store.js";
import { MAX_UPLOAD_BYTES, formatSize, type UploadInbox, type UploadLimits } from "./shared/uploads.js";

type Guard = (req: IncomingMessage, res: ServerResponse) => boolean;
const asMiddleware = (guard: Guard): RequestHandler => (req, res, next) => {
    if (guard(req, res)) next();
};

/**
 * El SDK rechaza los tokens sin vencimiento; al token fijo del modo local le ponemos uno lejano.
 * Segundos desde epoch: 1/1/3000.
 */
const NEVER = 32_503_680_000;

/** El usuario del store dueño del token, en `extra.userId`. */
export function userIdOf(authInfo: AuthInfo | undefined): number {
    const userId = authInfo?.extra?.userId;
    if (typeof userId !== "number") throw new Error("Request sin usuario autenticado.");
    return userId;
}

/** Busca el token en el store: el MCP solo acepta tokens de acceso vigentes. */
function storeVerifier(store: SessionStore): OAuthTokenVerifier {
    return {
        async verifyAccessToken(token) {
            const found = await store.findToken(token, "access");
            if (!found) throw new OAuthError(OAuthErrorCode.InvalidToken, "Token desconocido, vencido o revocado.");
            return {
                token,
                clientId: found.clientId ?? "desconocido",
                scopes: [],
                expiresAt: found.expiresAt ?? NEVER,
                extra: { userId: found.userId },
            };
        },
    };
}

/** El factory recibe en `ctx.authInfo` el token ya validado, con el usuario; de ahí arma su sesión. */
export function startHttpServer(factory: McpServerFactory, port: number, store: SessionStore, inbox: UploadInbox) {
    const handler = createMcpHandler(factory, { onerror: (e) => logger.error(e.message) });
    const verifier = storeVerifier(store);

    const requireToken: RequestHandler = async (req, res, next) => {
        try {
            // toNodeHandler le pasa `req.auth` al handler como `authInfo`.
            (req as { auth?: AuthInfo }).auth = await verifyBearerToken(req.headers.authorization, { verifier });
            next();
        } catch (e) {
            const challenge = bearerAuthChallengeResponse(e);
            res.status(challenge.status);
            challenge.headers.forEach((value, name) => res.setHeader(name, value));
            res.send(await challenge.text());
        }
    };

    const app = express();
    app.use(asMiddleware(localhostHostValidation()));
    app.use(asMiddleware(localhostOriginValidation()));
    // Sin express.json(): el handler lee el body por su cuenta.
    app.all("/mcp", requireToken, toNodeHandler(handler));
    // Sin bearer: el id del link es el secreto, y lo abre un navegador o un `curl` que no lo tienen.
    app.get("/subir/:id", (req, res) => {
        const upload = inbox.get(req.params.id);
        if (!upload) return void res.status(404).type("html").send(page("Link vencido", EXPIRED));
        res.type("html").send(page(upload.title, uploadForm(upload.limits)));
    });
    app.post("/subir/:id", (req, res) => receiveUpload(inbox, req, res));

    app.listen(port, "127.0.0.1", () => {
        logger.info(`Servidor MCP escuchando en http://127.0.0.1:${port}/mcp`);
    });
}

/** Recibe el multipart del formulario o de `curl -F archivos=@...`. Al navegador le contesta HTML; al resto, JSON. */
async function receiveUpload(inbox: UploadInbox, req: ExpressRequest, res: ExpressResponse): Promise<void> {
    const browser = req.accepts(["json", "html"]) === "html";
    const fail = (status: number, message: string) =>
        browser
            ? res.status(status).type("html").send(page("No se pudo subir", `<p>${escapeHtml(message)}</p>`))
            : res.status(status).json({ error: message });

    const id = String(req.params.id);
    if (!inbox.get(id)) return void fail(404, "El link de subida venció o no existe.");
    if (Number(req.headers["content-length"]) > MAX_UPLOAD_BYTES) {
        return void fail(413, `La subida pasa el máximo de ${formatSize(MAX_UPLOAD_BYTES)}.`);
    }

    try {
        // Request de la API web: parsea multipart sin sumar dependencias.
        const request = new Request(`http://localhost${req.url}`, {
            method: "POST",
            headers: req.headers as Record<string, string>,
            body: Readable.toWeb(req) as ReadableStream,
            duplex: "half",
        } as RequestInit);
        const form = await request.formData();
        const files = await Promise.all(
            form
                .getAll("archivos")
                .filter((v): v is File => typeof v !== "string" && v.size > 0)
                .map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })),
        );
        inbox.receive(id, files);
        const received = files.map((f) => ({ nombre: f.name, tamanio: f.bytes.length }));
        if (browser) {
            const list = received.map((f) => `<li>${escapeHtml(f.nombre)} (${formatSize(f.tamanio)})</li>`).join("");
            res.type("html").send(page("Listo", `<ul>${list}</ul><p>Volvé al chat y avisá que ya los subiste.</p>`));
        } else {
            res.json({ recibidos: received });
        }
    } catch (e) {
        fail(400, (e as Error).message);
    }
}

const EXPIRED = "<p>Este link de subida venció o ya no existe. Pedile al agente uno nuevo.</p>";

function uploadForm(limits: UploadLimits): string {
    const rules = [
        limits.maxFiles ? `hasta ${limits.maxFiles} archivo(s)` : "",
        `hasta ${formatSize(limits.maxBytes)} cada uno`,
        limits.extensions?.length ? `tipos: ${limits.extensions.join(", ")}` : "",
    ].filter(Boolean);
    const accept = limits.extensions?.length ? ` accept="${escapeHtml(limits.extensions.join(","))}"` : "";
    return (
        `<p>Elegí los archivos para la entrega (${escapeHtml(rules.join(", "))}).</p>` +
        `<form method="post" enctype="multipart/form-data">` +
        `<input type="file" name="archivos" multiple required${accept}>` +
        `<button type="submit">Subir</button></form>` +
        "<p class=nota>Subirlos no entrega la tarea: después el agente te confirma y la entrega.</p>"
    );
}

/** Página mínima: se abre desde el celu, así que nada más que lo necesario. */
function page(title: string, body: string): string {
    return (
        `<!doctype html><html lang="es"><head><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>` +
        "<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem;" +
        "line-height:1.5;color:#1a1a1a;background:#fff}@media(prefers-color-scheme:dark){body{color:#eee;" +
        "background:#151515}}form{display:flex;flex-direction:column;gap:1rem;margin:1.5rem 0}" +
        "button{padding:.7rem;font-size:1rem}.nota{opacity:.7;font-size:.9rem}</style></head>" +
        `<body><h1>${escapeHtml(title)}</h1>${body}</body></html>`
    );
}

const escapeHtml = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
