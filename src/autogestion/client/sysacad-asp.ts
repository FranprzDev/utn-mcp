import { HttpError } from "../../shared/http.js";
import {
    InvalidCredentialsError,
    LoginRequiredError,
    type AutogestionConnector,
    type AutogestionCredentials,
} from "./connector.js";

/**
 * Adaptador de referencia del conector Sysacad: el SysacadWEB clásico (ASP) de la FRT
 * (https://sysacad.frt.utn.edu.ar/, "Módulo de autogestión alumnos").
 * Verificado sin login (oct 2026): el formulario hace POST a `menuAlumno.asp` con `legajo` y
 * `password`, y la sesión viaja en la URL como `?id=NNNNN-NNNNNNNNN` (público en los resultados
 * de búsqueda de `menuAlumno_FRT.asp?id=...`). Las páginas detrás del login no son públicas:
 * en vez de adivinar sus nombres, se descubren por el texto de los enlaces del menú.
 */
const BASE_URL = "https://sysacad.frt.utn.edu.ar";

/** El POST del login, sacado del <form> público de la home de SysacadWEB. */
const LOGIN_PATH = "menuAlumno.asp";

/** Marcadores de la home de login: si una respuesta los trae, la sesión no quedó o venció. */
const LOGIN_PAGE_MARKERS = ["Ingreso Alumnos al SYSACAD", 'NAME="login"'];

/** Marcador de credenciales rechazadas: SysacadWEB avisa con la clase textoError de su CSS. */
const LOGIN_ERROR_MARKER = "textoError";

/** La sesión viaja en la URL: `menuAlumno_FRT.asp?id=30043-986741068` y todas las internas igual. */
const SESSION_ID_PATTERN = /[?&]id=(\d+-\d+)/;

/** SysacadWEB sirve HTML 4.01 en iso-8859-1, no UTF-8. */
function decode(buffer: ArrayBuffer): string {
    return new TextDecoder("iso-8859-1").decode(buffer);
}

/** Conector del SysacadWEB (ASP) de la FRT. La sesión es el `id` de la URL, no una cookie. */
export class SysacadAspConnector implements AutogestionConnector {
    readonly systemId = "sysacad-asp";

    private sessionId: string | null = null;
    private menuHtml: string | null = null;

    async login(credentials: AutogestionCredentials): Promise<void> {
        const body = new URLSearchParams({
            legajo: credentials.username,
            password: credentials.password,
            loginbutton: "Ingresar",
        });
        let res: Response;
        try {
            res = await fetch(`${BASE_URL}/${LOGIN_PATH}`, {
                method: "POST",
                body,
                redirect: "follow",
                signal: AbortSignal.timeout(30_000),
            });
        } catch (e) {
            throw new HttpError(`No se pudo conectar con ${new URL(BASE_URL).host}: ${(e as Error).message}`);
        }
        const html = decode(await res.arrayBuffer());
        if (html.includes(LOGIN_ERROR_MARKER)) throw new InvalidCredentialsError("Sysacad");
        const sessionId = SESSION_ID_PATTERN.exec(html)?.[1];
        if (!sessionId) {
            // Sin error explícito pero sin sesión: SysacadWEB a veces reimprime la home ante un rechazo.
            if (LOGIN_PAGE_MARKERS.some((m) => html.includes(m))) {
                throw new InvalidCredentialsError("Sysacad");
            }
            throw new HttpError("Sysacad no devolvió sesión y no es la página de login: cambió la pantalla de ingreso.");
        }
        this.sessionId = sessionId;
        this.menuHtml = html;
    }

    async fetchEstadoAcademico(): Promise<string> {
        return this.fetchLinkedPage(/estado\s*acad/i, "estado académico");
    }

    async fetchCorrelatividades(): Promise<string> {
        return this.fetchLinkedPage(/correlatividad/i, "correlatividades");
    }

    /**
     * Sigue del menú el enlace cuyo texto matchea `linkText`: los nombres de las páginas internas
     * no son públicos, y el menú las anuncia con su href ya resuelto (igual que la navegación por
     * `direccion` del aula). Si no aparece, el error lista las opciones reales del menú para ajustar.
     */
    private async fetchLinkedPage(linkText: RegExp, label: string): Promise<string> {
        if (!this.sessionId || !this.menuHtml) throw new LoginRequiredError("Sysacad");
        const href = this.findMenuLink(this.menuHtml, linkText);
        if (!href) {
            const options = [...this.menuHtml.matchAll(/<a\s[^>]*href="[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)]
                .map((m) => m[1].replace(/<[^>]+>/g, "").trim())
                .filter(Boolean);
            throw new HttpError(
                `No encontré "${label}" en el menú de Sysacad. Opciones que muestra: ${options.join(", ")}.`,
            );
        }
        return this.fetchPage(href);
    }

    /** GET de una página interna con la sesión en la URL; si venció, el caller decide re-loguear. */
    private async fetchPage(href: string): Promise<string> {
        if (!this.sessionId) throw new LoginRequiredError("Sysacad");
        const url = new URL(href, `${BASE_URL}/`);
        if (url.origin !== new URL(BASE_URL).origin) {
            // Un enlace interno legítimo no sale del host; no le mandamos la sesión a otro lado.
            throw new HttpError(`Sysacad devolvió un enlace fuera de ${url.host}: no se sigue.`);
        }
        if (!url.searchParams.get("id")) url.searchParams.set("id", this.sessionId);
        let res: Response;
        try {
            res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
        } catch (e) {
            throw new HttpError(`No se pudo conectar con ${url.host}: ${(e as Error).message}`);
        }
        const html = decode(await res.arrayBuffer());
        if (LOGIN_PAGE_MARKERS.some((m) => html.includes(m))) {
            // Sesión vencida: una sola marca para que la tool decida re-loguear una vez, como refreshToken.
            this.sessionId = null;
            throw new LoginRequiredError("Sysacad");
        }
        return html;
    }

    /** href del primer enlace del menú cuyo texto visible matchea. */
    private findMenuLink(menuHtml: string, linkText: RegExp): string | null {
        for (const m of menuHtml.matchAll(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)) {
            const text = m[2].replace(/<[^>]+>/g, "").trim();
            if (linkText.test(text)) return m[1];
        }
        return null;
    }
}
