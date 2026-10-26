import { SysacadAspConnector } from "./sysacad-asp.js";
import type { Correlatividades, EstadoMateria, ExamenMateria, NotasParcialesMateria } from "./types.js";

export interface AutogestionConnector {
    readonly systemId: string;
    login(credentials: AutogestionCredentials): Promise<void>;
    estadoAcademico(): Promise<EstadoMateria[]>;
    correlatividades(): Promise<Correlatividades>;
    notasParciales?(): Promise<NotasParcialesMateria[]>;
    examenes?(): Promise<ExamenMateria[]>;
}

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

export type SystemSupport = "verified" | "unverified";

export interface AutogestionSystem {
    id: string;
    name: string;
    support: SystemSupport;
    create(): AutogestionConnector;
}

const SYSTEM_BY_REGIONAL: Record<string, string> = {
    frt: "sysacad-asp",
};

export const SYSTEMS: Record<string, AutogestionSystem> = {
    "sysacad-asp": {
        id: "sysacad-asp",
        name: "SYSACAD (ASP clásico, FRT)",
        support: "verified",
        create: () => new SysacadAspConnector(),
    },
};

export function systemForRegional(regionalId: string): AutogestionSystem | null {
    const systemId = SYSTEM_BY_REGIONAL[regionalId];
    return (systemId && SYSTEMS[systemId]) || null;
}

export function registerSystem(system: AutogestionSystem): void {
    SYSTEMS[system.id] = system;
}
