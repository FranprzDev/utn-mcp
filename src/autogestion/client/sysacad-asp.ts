import { HttpError } from "../../shared/http.js";
import {
    InvalidCredentialsError,
    LoginRequiredError,
    type AutogestionConnector,
    type AutogestionCredentials,
} from "./connector.js";
import type { Correlatividades, EstadoMateria, ExamenMateria, NotasParcialesMateria } from "./types.js";
import { parseCorrelatividadesPagina } from "./sysacad-asp/correlatividades.js";
import { parseEstadoAcademico } from "./sysacad-asp/estado-academico.js";
import { parseExamenes } from "./sysacad-asp/examenes.js";
import { normalizarMateria, parseNotasParciales } from "./sysacad-asp/notas-parciales.js";

const BASE_URL = "https://sysacad.frt.utn.edu.ar";

const LOGIN_PATH = "menuAlumno.asp";

const LOGIN_PAGE_MARKERS = ["Ingreso Alumnos al SYSACAD", 'NAME="login"'];

const LOGIN_ERROR_PATTERN = /<p class="textoError">/i;

const SESSION_ID_PATTERN = /[?&]id=(\d+-\d+)/;

function decode(buffer: ArrayBuffer): string {
    return new TextDecoder("iso-8859-1").decode(buffer);
}

export class SysacadAspConnector implements AutogestionConnector {
    readonly systemId = "sysacad-asp";

    private credentials: AutogestionCredentials | null = null;
    private sessionId: string | null = null;
    private sessionCookie: string | null = null;
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
        const sessionId = SESSION_ID_PATTERN.exec(html)?.[1];
        if (!sessionId) {
            if (LOGIN_ERROR_PATTERN.test(html) || LOGIN_PAGE_MARKERS.some((m) => html.includes(m))) {
                throw new InvalidCredentialsError("Sysacad");
            }
            throw new HttpError("Sysacad no devolvió sesión y no es la página de login: cambió la pantalla de ingreso.");
        }
        this.credentials = credentials;
        this.sessionId = sessionId;
        this.sessionCookie = res.headers
            .getSetCookie()
            .map((c) => c.split(";")[0])
            .join("; ");
        this.menuHtml = html;
    }

    async estadoAcademico(): Promise<EstadoMateria[]> {
        const materias = parseEstadoAcademico(await this.fetchEstadoAcademico());
        const cursando = new Set(
            parseNotasParciales(await this.fetchNotasParciales())
                .filter((m) => m.cursando)
                .map((m) => normalizarMateria(m.materia)),
        );
        for (const entry of materias) {
            if (cursando.has(normalizarMateria(entry.materia))) entry.estado = "Cursando";
        }
        return materias;
    }

    async correlatividades(): Promise<Correlatividades> {
        return {
            cursar: parseCorrelatividadesPagina(await this.fetchCorrelatividades(), "cursar"),
            rendir: parseCorrelatividadesPagina(await this.fetchCorrelatividadesExamen(), "rendir"),
        };
    }

    async notasParciales(): Promise<NotasParcialesMateria[]> {
        return parseNotasParciales(await this.fetchNotasParciales());
    }

    async examenes(): Promise<ExamenMateria[]> {
        return parseExamenes(await this.fetchExamenes());
    }

    private async fetchEstadoAcademico(): Promise<string> {
        return this.fetchLinkedPage(/estado\s*acad/i, "estado académico");
    }

    private async fetchCorrelatividades(): Promise<string> {
        return this.fetchLinkedPage(/correlatividad\s*para\s*cursar/i, "correlatividades para cursar");
    }

    private async fetchCorrelatividadesExamen(): Promise<string> {
        return this.fetchLinkedPage(/correlatividad\s*para\s*rendir/i, "correlatividades para rendir");
    }

    private async fetchNotasParciales(): Promise<string> {
        return this.fetchLinkedPage(/notas?\s*de?\s*parcial/i, "notas de parciales");
    }

    private async fetchExamenes(): Promise<string> {
        return this.fetchLinkedPage(/^ex[aá]menes$/i, "exámenes");
    }

    private async fetchLinkedPage(linkText: RegExp, label: string, retry = true): Promise<string> {
        if (!this.sessionId && this.credentials) {
            await this.login(this.credentials);
            retry = false;
        }
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
        try {
            return await this.fetchPage(href);
        } catch (error) {
            if (!(error instanceof LoginRequiredError) || !retry || !this.credentials) throw error;
            await this.login(this.credentials);
            return this.fetchLinkedPage(linkText, label, false);
        }
    }

    private async fetchPage(href: string): Promise<string> {
        if (!this.sessionId) throw new LoginRequiredError("Sysacad");
        const url = new URL(href, `${BASE_URL}/`);
        if (url.origin !== new URL(BASE_URL).origin) {
            throw new HttpError(`Sysacad devolvió un enlace fuera de ${url.host}: no se sigue.`);
        }
        if (!url.searchParams.get("id")) url.searchParams.set("id", this.sessionId);
        let res: Response;
        try {
            res = await fetch(url, {
                headers: this.sessionCookie ? { cookie: this.sessionCookie } : {},
                signal: AbortSignal.timeout(30_000),
            });
        } catch (e) {
            throw new HttpError(`No se pudo conectar con ${url.host}: ${(e as Error).message}`);
        }
        const html = decode(await res.arrayBuffer());
        if (LOGIN_PAGE_MARKERS.some((m) => html.includes(m))) {
            this.sessionId = null;
            this.sessionCookie = null;
            throw new LoginRequiredError("Sysacad");
        }
        return html;
    }

    private findMenuLink(menuHtml: string, linkText: RegExp): string | null {
        for (const m of menuHtml.matchAll(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)) {
            const text = m[2].replace(/<[^>]+>/g, "").trim();
            if (linkText.test(text)) return m[1];
        }
        return null;
    }
}
