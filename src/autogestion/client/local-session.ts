import { UnsupportedRegionalError, systemForRegional, type AutogestionConnector } from "./connector.js";
import { loadAutogestionCredentials } from "./credentials.js";
import type { AutogestionSession } from "./session.js";

/**
 * Sesión del modo local: un solo usuario, el de la compu. Resuelve el sistema a partir de la
 * regional (la misma que eligió para el aula) y loguea el conector con las credenciales del
 * keychain o las env vars, una vez por sistema y bajo demanda: el primer uso es el que pide login.
 */
export class LocalAutogestionSession implements AutogestionSession {
    /** Conectores ya logueados, por sistema: un login alcanza para todas las tools. */
    private readonly connectors = new Map<string, Promise<AutogestionConnector>>();

    /** `getRegionalId` se inyecta para no importar la plataforma del aula: las plataformas no se conocen. */
    constructor(private readonly getRegionalId: () => Promise<string>) {}

    getConnector(): Promise<AutogestionConnector> {
        return this.getRegionalId().then((regionalId) => {
            const system = systemForRegional(regionalId);
            if (!system) throw new UnsupportedRegionalError(regionalId);
            let connector = this.connectors.get(system.id);
            if (!connector) {
                connector = this.login(system.id, system.create());
                this.connectors.set(system.id, connector);
            }
            return connector;
        });
    }

    private async login(systemId: string, connector: AutogestionConnector): Promise<AutogestionConnector> {
        const credentials = await loadAutogestionCredentials(systemId);
        if (!credentials) {
            const { LoginRequiredError } = await import("./connector.js");
            throw new LoginRequiredError("la autogestión de tu regional");
        }
        await connector.login(credentials);
        return connector;
    }
}
