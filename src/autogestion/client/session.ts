import type { AutogestionConnector } from "./connector.js";

/**
 * La autogestión del usuario. Todo lo que habla con el sistema recibe esto y no sabe de dónde sale:
 * `LocalAutogestionSession` (STDIO, el usuario de la compu). El modo HTTP todavía no la tiene
 * resuelta: las credenciales por sistema de cada usuario quedan como decisión de diseño abierta.
 */
export interface AutogestionSession {
    /**
     * El conector del sistema que usa la regional del usuario, logueado y listo.
     * Rechaza con UnsupportedRegionalError si su regional no tiene conector todavía.
     */
    getConnector(): Promise<AutogestionConnector>;
}
