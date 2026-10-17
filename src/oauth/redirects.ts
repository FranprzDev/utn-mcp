/** A dónde puede volver el navegador después del login. */
export interface RedirectAllowlist {
    /** Hostnames a los que se vuelve por HTTPS sin aviso. */
    hosts: Set<string>;
    /** Esquemas de apps instaladas, con los dos puntos (`cursor:`). */
    schemes: Set<string>;
}

/** Los callbacks de los clientes MCP conocidos (Claude, ChatGPT, VS Code web) y los esquemas de editores. */
const DEFAULT_HOSTS = ["claude.ai", "claude.com", "chatgpt.com", "chat.openai.com", "vscode.dev", "insiders.vscode.dev"];
const DEFAULT_SCHEMES = ["cursor:", "vscode:", "vscode-insiders:", "windsurf:"];

/** En loopback la redirección queda en la compu del usuario: ahí escuchan los clientes de escritorio. */
const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];

/**
 * Los conocidos más los de UTN_MCP_REDIRECT_ALLOW, separados por coma: hosts (`app.ejemplo.com`)
 * o esquemas terminados en dos puntos (`miapp:`).
 */
export function redirectAllowlistFromEnv(env: NodeJS.ProcessEnv = process.env): RedirectAllowlist {
    const extra = (env.UTN_MCP_REDIRECT_ALLOW ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
    return {
        hosts: new Set([...DEFAULT_HOSTS, ...extra.filter((e) => !e.endsWith(":"))]),
        schemes: new Set([...DEFAULT_SCHEMES, ...extra.filter((e) => e.endsWith(":"))]),
    };
}

/**
 * `trusted`: loopback, un host HTTPS de la lista o el esquema de una app de la lista.
 * `unknown`: cualquier otro host HTTPS, como el de un agente propio; se acepta con aviso.
 * `rejected`: el resto.
 */
export function redirectTrust(uri: unknown, allow: RedirectAllowlist): "trusted" | "unknown" | "rejected" {
    if (typeof uri !== "string") return "rejected";
    let url: URL;
    try {
        url = new URL(uri);
    } catch {
        return "rejected";
    }
    if (url.hash || url.username || url.password) return "rejected";
    if (url.protocol === "http:" || url.protocol === "https:") {
        if (LOOPBACK.includes(url.hostname)) return "trusted";
        if (url.protocol === "http:") return "rejected";
        return allow.hosts.has(url.hostname) ? "trusted" : "unknown";
    }
    return allow.schemes.has(url.protocol) ? "trusted" : "rejected";
}

/** Cómo se le nombra al usuario el destino. */
export function describeRedirect(uri: string): string {
    const url = new URL(uri);
    if (LOOPBACK.includes(url.hostname)) return "una app en tu compu";
    if (url.protocol === "https:") return url.hostname;
    return `la app ${url.protocol.slice(0, -1)}`;
}
