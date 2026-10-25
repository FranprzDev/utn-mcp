import type { AulaSession } from "../client/session.js";
import { MoodleError } from "../client/moodle-api.js";

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
