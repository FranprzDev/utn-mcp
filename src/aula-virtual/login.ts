import { CookieJar } from "tough-cookie";
import { ask, askHidden } from "../shared/input.js";
import { logger } from "../shared/logger.js";
import { SqliteStore } from "../shared/store/sqlite-store.js";
import { saveCredentials, type Credentials } from "./client/credentials.js";
import { LocalSession } from "./client/local-session.js";
import { fetchToken } from "./client/sso-login.js";
import { AULA_PLATFORM, type StoredAulaData } from "./client/stored-session.js";

/**
 * `utn-mcp login`: pide usuario y contraseña una vez, los guarda en el keychain
 * y obtiene el primer token. Después el servidor renueva solo.
 * Con `--http` guarda la sesión en el store y emite el token para el cliente MCP.
 */
export async function runLogin(http: boolean): Promise<void> {
    const username = (await ask("Usuario institucional de la UTN: ")).trim();
    if (!username) throw new Error("Falta el usuario.");
    const password = await askHidden("Contraseña: ");
    const credentials = { username, password };

    let accessToken: string | null = null;
    if (http) accessToken = await loginToStore(credentials);
    else await new LocalSession().login(credentials);

    // Se guardan recién después de comprobar que el SSO las aceptó.
    if (await saveCredentials(credentials)) {
        logger.info("Credenciales guardadas en el keychain del sistema.");
    } else {
        logger.warn("No hay keychain disponible: para renovar sin intervención definí UTN_USER y UTN_PASS.");
    }

    if (accessToken) {
        logger.info(
            "Listo. Configurá tu cliente MCP con este header; no se vuelve a mostrar:\n\n" +
                `    Authorization: Bearer ${accessToken}\n`,
        );
    } else {
        logger.info("Listo: ya podés usar el servidor MCP.");
    }
}

/** Crea el usuario si no existe, guarda su sesión del aula y le emite un token que no vence. */
async function loginToStore(credentials: Credentials): Promise<string> {
    const jar = new CookieJar();
    const token = await fetchToken(jar, credentials);

    const store = await SqliteStore.open();
    const userId = await store.findOrCreateUser(credentials.username);
    // En minúscula, igual que en `users`: es con lo que se compara al renovar.
    const data: StoredAulaData = { username: credentials.username.toLowerCase(), token, cookies: await jar.serialize() };
    await store.saveSession(userId, AULA_PLATFORM, JSON.stringify(data));
    return store.issueToken(userId, { kind: "access", clientId: "local" });
}
