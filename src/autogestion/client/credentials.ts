import { logger } from "../../shared/logger.js";
import type { AutogestionCredentials } from "./connector.js";

const SERVICE = "utn-mcp";
const account = (systemId: string) => `autogestion-${systemId}`;

async function entry(systemId: string) {
    const { Entry } = await import("@napi-rs/keyring");
    return new Entry(SERVICE, account(systemId));
}

function envNames(systemId: string): [string, string] {
    const prefix = systemId.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    return [`${prefix}_USER`, `${prefix}_PASS`];
}

export async function loadAutogestionCredentials(systemId: string): Promise<AutogestionCredentials | null> {
    const [userEnv, passEnv] = envNames(systemId);
    const username = process.env[userEnv];
    const password = process.env[passEnv];
    if (username && password) return { username, password };

    try {
        const raw = (await entry(systemId)).getPassword();
        return raw ? (JSON.parse(raw) as AutogestionCredentials) : null;
    } catch (e) {
        logger.warn("Keychain no disponible:", (e as Error).message);
        return null;
    }
}

export async function saveAutogestionCredentials(
    systemId: string,
    creds: AutogestionCredentials,
): Promise<boolean> {
    try {
        (await entry(systemId)).setPassword(JSON.stringify(creds));
        return true;
    } catch (e) {
        logger.warn("No se pudo guardar en el keychain:", (e as Error).message);
        return false;
    }
}
