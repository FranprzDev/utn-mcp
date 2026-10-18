import { randomInt } from "node:crypto";
import type { CookieJar } from "tough-cookie";
import type { Credentials } from "./credentials.js";
import { AULA_BASE_URL, SSO_HOST } from "./constants.js";

export class LoginRequiredError extends Error {
    constructor(message = "Hace falta iniciar sesión: corré `utn-mcp login`.") {
        super(message);
        this.name = "LoginRequiredError";
    }
}

export class InvalidCredentialsError extends Error {
    constructor(motivo?: string) {
        const base = "El aula rechazó usuario o contraseña. Corré `utn-mcp login` para actualizarlos.";
        super(motivo ? `${base} Motivo del aula: ${motivo}` : base);
        this.name = "InvalidCredentialsError";
    }
}

const MAX_REDIRECTS = 20;
const TIMEOUT_MS = 30_000;

type Landing = { token: string } | { url: string; html: string };

export async function fetchToken(jar: CookieJar, credentials: Credentials | null): Promise<string> {
    if (!SSO_HOST) {
        if (!credentials) throw new LoginRequiredError();
        const viaTokenPhp = await tryTokenPhp(credentials);
        if (viaTokenPhp) return viaTokenPhp;
    }

    const launchUrl =
        `${AULA_BASE_URL}/admin/tool/mobile/launch.php` +
        `?service=moodle_mobile_app&passport=${randomInt(1e9)}&urlscheme=moodlemobile`;

    let landing = await follow(jar, launchUrl);
    if ("token" in landing) return landing.token;

    const oauthUrl = landing.html.match(/href="([^"]*\/auth\/oauth2\/login\.php[^"]*)"/)?.[1];
    if (oauthUrl) {
        landing = await follow(jar, decodeHtml(oauthUrl));
        if ("token" in landing) return landing.token;

        if (SSO_HOST && new URL(landing.url).host === SSO_HOST) {
            if (!credentials) throw new LoginRequiredError();
            landing = await submitSsoForm(jar, landing.html, credentials);
            if ("token" in landing) return landing.token;
            if (SSO_HOST && new URL(landing.url).host === SSO_HOST) throw new InvalidCredentialsError(extractLoginError(landing.html));
        }
    } else {
        if (!credentials) throw new LoginRequiredError();
        const loginPageUrl = `${AULA_BASE_URL}/login/index.php`;
        const loginPage = await follow(jar, loginPageUrl);
        if ("token" in loginPage) return loginPage.token;
        landing = await submitMoodleLoginForm(jar, loginPage.url, loginPage.html, credentials);
        if ("token" in landing) return landing.token;
        const sigueEnLogin =
            landing.url.includes("/login") ||
            /alert-danger/i.test(landing.html) ||
            /loginerrors/i.test(landing.html);
        if (sigueEnLogin) {
            const motivo = extractLoginError(landing.html);
            throw new InvalidCredentialsError(motivo);
        }
    }

    landing = await follow(jar, launchUrl);
    if ("token" in landing) return landing.token;

    if (!SSO_HOST && credentials) {
        const viaTokenPhp = await tryTokenPhp(credentials);
        if (viaTokenPhp) return viaTokenPhp;
    }

    throw unexpected(landing.url);
}

async function tryTokenPhp(credentials: Credentials): Promise<string | null> {
    try {
        const res = await fetch(`${AULA_BASE_URL}/login/token.php`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                username: credentials.username,
                password: credentials.password,
                service: "moodle_mobile_app",
            }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const data = (await res.json()) as { token?: string; error?: string; errorcode?: string };
        if (data.token) return data.token;
        if (data.error || data.errorcode) {
            if (data.errorcode === "invalidlogin" || /invalid login/i.test(data.error ?? "")) {
                throw new InvalidCredentialsError(data.error);
            }
        }
        return null;
    } catch (e) {
        if (e instanceof InvalidCredentialsError) throw e;
        return null;
    }
}

async function submitSsoForm(jar: CookieJar, html: string, { username, password }: Credentials): Promise<Landing> {
    const action = html.match(/"loginAction"\s*:\s*("(?:[^"\\]|\\.)*")/)?.[1];
    if (!action) throw new Error("No se encontró el formulario del SSO; puede que haya cambiado.");

    const body = new URLSearchParams({ username, password, rememberMe: "on", credentialId: "" });
    return follow(jar, JSON.parse(action) as string, { method: "POST", body });
}

async function submitMoodleLoginForm(
    jar: CookieJar,
    pageUrl: string,
    html: string,
    { username, password }: Credentials,
): Promise<Landing> {
    const tokenMatch =
        html.match(/name="logintoken"\s+value="([^"]*)"/) ||
        html.match(/value="([^"]*)"\s+name="logintoken"/);
    const logintoken = tokenMatch?.[1] ?? "";

    const actionMatch = html.match(/<form[^>]*action="([^"]*)"[^>]*>/i);
    let action = actionMatch?.[1] ? decodeHtml(actionMatch[1]) : "";
    if (!action) action = pageUrl;
    if (!action.startsWith("http")) action = new URL(action, pageUrl).toString();

    const body = new URLSearchParams({ username, password, logintoken, anchor: "" });
    return follow(jar, action, { method: "POST", body });
}

async function follow(jar: CookieJar, url: string, init?: RequestInit): Promise<Landing> {
    for (let i = 0; i < MAX_REDIRECTS; i++) {
        const cookie = await jar.getCookieString(url);
        const res = await fetch(url, {
            ...init,
            redirect: "manual",
            headers: cookie ? { cookie } : {},
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        for (const setCookie of res.headers.getSetCookie()) {
            await jar.setCookie(setCookie, url, { ignoreError: true });
        }

        const location = res.headers.get("location");
        if (res.status >= 300 && res.status < 400 && location) {
            await res.body?.cancel();
            if (location.startsWith("moodlemobile://")) return { token: decodeLaunchToken(location) };
            url = new URL(location, url).toString();
            init = undefined;
            continue;
        }
        return { url, html: await res.text() };
    }
    throw new Error("Demasiadas redirecciones en el login.");
}

export function decodeLaunchToken(url: string): string {
    const encoded = decodeURIComponent(url.split("token=")[1] ?? "");
    const parts = Buffer.from(encoded, "base64").toString("utf8").split(":::");
    if (parts.length < 2 || !parts[1]) throw new Error("Formato de token inesperado en launch.php");
    return parts[1];
}

const decodeHtml = (s: string) => s.replaceAll("&amp;", "&");

function extractLoginError(html: string): string | undefined {
    const patterns = [
        /alert-danger[^>]*>([\s\S]*?)<\/div>/i,
        /alert-error[^>]*>([\s\S]*?)<\/div>/i,
        /class="[^"]*error[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
        /<div[^>]*id="loginerrormessage"[^>]*>([\s\S]*?)<\/div>/i,
    ];
    for (const re of patterns) {
        const m = html.match(re);
        if (m?.[1]) {
            const text = m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
            if (text) return text;
        }
    }
    return undefined;
}

const unexpected = (url: string) => {
    const { host, pathname } = new URL(url);
    return new Error(`Flujo de login inesperado: terminó en ${host}${pathname}`);
};