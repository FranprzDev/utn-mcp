import type { AutogestionConnector } from "./connector.js";

export interface AutogestionSession {
    getConnector(): Promise<AutogestionConnector>;
}
