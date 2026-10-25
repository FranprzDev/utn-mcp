import { SysacadAspConnector } from "./sysacad-asp.js";

/**
 * Un sistema de autogestión académica de una regional (Sysacad, SIU Guaraní, etc.).
 * Cada sistema es un conector que implementa esta interfaz; las regionales se enchufan
 * en `SYSTEM_BY_REGIONAL` y el conector nuevo en `SYSTEMS`. Es la "interfaz abierta"
 * del mecanismo de plugins propuesto en el issue #22: cada quien enchufa su parser.
 */
export interface AutogestionConnector {
    /** Id del sistema, tal como figura en `SYSTEMS`. */
    readonly systemId: string;
    /** Pide legajo/usuario y contraseña al sistema y deja la sesión lista. */
    login(credentials: AutogestionCredentials): Promise<void>;
    /** HTML de la página de estado académico del alumno logueado. */
    fetchEstadoAcademico(): Promise<string>;
    /** HTML de la página de correlatividades de la carrera del alumno logueado. */
    fetchCorrelatividades(): Promise<string>;
}

/** Credenciales de un sistema de autogestión. En Sysacad `username` es el legajo. */
export interface AutogestionCredentials {
    username: string;
    password: string;
}

export class LoginRequiredError extends Error {
    constructor(systemName: string) {
        super(`Falta iniciar sesión en ${systemName}: corré \`utn-mcp login autogestion\` una vez.`);
        this.name = "LoginRequiredError";
    }
}

export class InvalidCredentialsError extends Error {
    constructor(systemName: string) {
        super(`${systemName} rechazó el usuario o la contraseña. Revisalos con \`utn-mcp login autogestion\`.`);
        this.name = "InvalidCredentialsError";
    }
}

export class UnsupportedRegionalError extends Error {
    constructor(regionalId: string) {
        super(
            `La regional ${regionalId.toUpperCase()} todavía no tiene conector de autogestión. ` +
                "Los que existen están en src/autogestion/client/connector.ts (SYSTEM_BY_REGIONAL); " +
                "enchufar uno nuevo es agregar su entrada ahí y su cliente en SYSTEMS.",
        );
        this.name = "UnsupportedRegionalError";
    }
}

/** Qué se sabe del conector: `verified` = alguien entró con una cuenta real; `unverified` = falta esa prueba. */
export type SystemSupport = "verified" | "unverified";

export interface AutogestionSystem {
    id: string;
    name: string;
    support: SystemSupport;
    create(): AutogestionConnector;
}

/**
 * Qué sistema de autogestión usa cada regional. Es la resolución dinámica del issue #22:
 * cada regional enchufa el suyo y el MCP no le impone al usuario un sistema que no usa.
 */
const SYSTEM_BY_REGIONAL: Record<string, string> = {
    // FRT usa SysacadWEB (https://sysacad.frt.utn.edu.ar/, verificado públicamente oct 2026).
    frt: "sysacad-asp",
};

/** Los conectores que existen hoy. Referencia: `sysacad-asp` (FRT); un Guaraní iría acá al lado. */
export const SYSTEMS: Record<string, AutogestionSystem> = {
    "sysacad-asp": {
        id: "sysacad-asp",
        name: "SYSACAD (ASP clásico, FRT)",
        // El formulario de login está verificado públicamente; falta la prueba con una cuenta real.
        support: "unverified",
        create: () => new SysacadAspConnector(),
    },
};

/** El sistema de una regional, o null si todavía nadie enchufó su conector. */
export function systemForRegional(regionalId: string): AutogestionSystem | null {
    const systemId = SYSTEM_BY_REGIONAL[regionalId];
    return (systemId && SYSTEMS[systemId]) || null;
}

/** Registro perezoso para no cargar clientes que la regional del usuario no usa. */
export function registerSystem(system: AutogestionSystem): void {
    SYSTEMS[system.id] = system;
}
