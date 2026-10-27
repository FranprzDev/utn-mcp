import { loadInstalledSystems } from "./client/installed-systems.js";
import { ask, askHidden } from "../shared/input.js";
import { logger } from "../shared/logger.js";
import { systemForRegional, UnsupportedRegionalError } from "./client/connector.js";
import { saveAutogestionCredentials } from "./client/credentials.js";

export async function runAutogestionLogin(regionalId: string): Promise<void> {
    const system = systemForRegional(regionalId, await loadInstalledSystems());
    if (!system) throw new UnsupportedRegionalError(regionalId);

    const username = (await ask("Legajo o usuario de la autogestión: ")).trim();
    if (!username) throw new Error("Falta el usuario.");
    const password = await askHidden("Contraseña: ");

    const connector = system.create();
    await connector.login({ username, password });

    if (await saveAutogestionCredentials(system.id, { username, password })) {
        logger.info("Credenciales guardadas en el keychain del sistema.");
    } else {
        logger.warn("No hay keychain disponible: definí las variables de entorno del sistema (ver README).");
    }
    logger.info(`Listo: autogestión ${system.name} conectada.`);
}
