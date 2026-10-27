import { McpServer } from "@modelcontextprotocol/server";
import type { AulaSession } from "./aula-virtual/client/session.js";
import { registerAulaVirtualTools } from "./aula-virtual/tools.js";
import { loadInstalledSystems } from "./autogestion/client/installed-systems.js";
import { LocalAutogestionSession } from "./autogestion/client/local-session.js";
import { registerAutogestionTools } from "./autogestion/tools.js";
import type { FileSource } from "./shared/uploads.js";

/**
 * Un servidor MCP para un usuario. Las entradas STDIO y HTTP lo crean por conexión o por request.
 * `files`: de dónde salen los archivos que el usuario sube a una plataforma.
 */
export function createServer(
    aula: AulaSession,
    files: FileSource,
    getRegionalId?: () => Promise<string>,
): McpServer {
    const server = new McpServer({
        name: "UTN-MCP",
        version: "0.9.0",
    });

    registerAulaVirtualTools(server, aula, files);
    if (getRegionalId) {
        const systems = loadInstalledSystems;
        registerAutogestionTools(server, new LocalAutogestionSession(getRegionalId, systems), getRegionalId, systems);
    }

    return server;
}
