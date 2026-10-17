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
import { hostHeaderValidation, originValidation, toNodeHandler } from "@modelcontextprotocol/node";
import type { AccessPolicy } from "./oauth/access.js";
import { mountOAuth } from "./oauth/server.js";
import { logger } from "./shared/logger.js";
import type { SessionStore } from "./shared/store/session-store.js";
import { escapeHtml, page } from "./shared/pages.js";
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

const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];

/** Dónde escucha el servidor y, si está publicado, desde qué dirección lo ven los clientes. */
export interface HttpOptions {
    host: string;
    port: number;
    /** Sin barra final, por ejemplo `https://sv.utnmcp.com.ar`. */
    publicUrl?: string;
    /** Quién puede conectarse por OAuth. */
    access: AccessPolicy;
}

/** El factory recibe en `ctx.authInfo` el token ya validado, con el usuario; de ahí arma su sesión. */
export function startHttpServer(factory: McpServerFactory, options: HttpOptions, store: SessionStore, inbox: UploadInbox) {
    const { host, port, publicUrl, access } = options;
    const handler = createMcpHandler(factory, { onerror: (e) => logger.error(e.message) });
    const verifier = storeVerifier(store);
    const app = express();
    // Detrás de un reverse proxy en la misma máquina: la IP del cliente (para el rate limit) viene en X-Forwarded-For.
    app.set("trust proxy", "loopback");

    // Contra DNS rebinding: solo se aceptan los hosts de esta máquina y el de la URL pública.
    const allowed = publicUrl ? [...LOOPBACK, new URL(publicUrl).hostname] : LOOPBACK;
    if (!publicUrl && !LOOPBACK.includes(host)) {
        logger.warn(`Escuchando en ${host} sin UTN_MCP_PUBLIC_URL: se rechazan los requests que no lleguen como localhost.`);
    }
    app.use(asMiddleware(hostHeaderValidation(allowed)));
    // Origin solo donde un navegador ajeno no tiene nada que hacer; los endpoints de OAuth tienen CORS abierto.
    const sameOrigin = asMiddleware(originValidation(allowed));

    const resourceMetadataUrl = mountOAuth(app, {
        issuer: publicUrl ?? `http://127.0.0.1:${port}`,
        store,
        access,
        sameOrigin,
    });

    const requireToken: RequestHandler = async (req, res, next) => {
        try {
            // toNodeHandler le pasa `req.auth` al handler como `authInfo`.
            (req as { auth?: AuthInfo }).auth = await verifyBearerToken(req.headers.authorization, { verifier });
            next();
        } catch (e) {
            // El 401 dice dónde está la metadata: de ahí el cliente arranca el OAuth.
            const challenge = bearerAuthChallengeResponse(e, { resourceMetadataUrl });
            res.status(challenge.status);
            challenge.headers.forEach((value, name) => res.setHeader(name, value));
            res.send(await challenge.text());
        }
    };

    // Sin express.json(): el handler lee el body por su cuenta.
    app.all("/mcp", sameOrigin, requireToken, toNodeHandler(handler));
    // Sin bearer: el id del link es el secreto, y lo abre un navegador o un `curl` que no lo tienen.
    app.get("/subir/:id", sameOrigin, (req, res) => {
        const upload = inbox.get(String(req.params.id));
        if (!upload) return void res.status(404).type("html").send(page("Link vencido", EXPIRED));
        res.type("html").send(page(upload.title, uploadForm(upload.limits)));
    });
    app.post("/subir/:id", sameOrigin, (req, res) => receiveUpload(inbox, req, res));

    app.listen(port, host, () => {
        logger.info(`Servidor MCP escuchando en http://${host}:${port}/mcp`);
        if (publicUrl) logger.info(`Publicado en ${publicUrl}/mcp`);
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
