import { UnsupportedRegionalError, systemForRegional, type AutogestionConnector } from "./connector.js";
import { loadAutogestionCredentials } from "./credentials.js";
import type { AutogestionSession } from "./session.js";

export class LocalAutogestionSession implements AutogestionSession {
    private readonly connectors = new Map<string, Promise<AutogestionConnector>>();

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
