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
            `La regional ${regionalId.toUpperCase()} no tiene un conector de autogestión instalado y configurado. ` +
                "Instalá el conector de tu regional y agregá su paquete a UTN_MCP_CONNECTORS. " +
                "El aula virtual se puede seguir usando sin autogestión.",
        );
        this.name = "UnsupportedRegionalError";
    }
}

export type SystemSupport = "verified" | "unverified";

export interface AutogestionSystem {
    id: string;
    name: string;
    support: SystemSupport;
    regionales: string[];
    create(): AutogestionConnector;
}

export function systemForRegional(regionalId: string, systems: AutogestionSystem[]): AutogestionSystem | null {
    return systems.find((system) => system.regionales.includes(regionalId)) ?? null;
}

export { HttpError } from "../../shared/http.js";
export { htmlToText } from "../../shared/html.js";
export type { CorrelatividadMateria, Correlatividades, EstadoMateria, ExamenMateria, NotasParcialesMateria } from "./types.js";
