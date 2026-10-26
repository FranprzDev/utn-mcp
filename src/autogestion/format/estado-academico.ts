import type { AutogestionSession } from "../client/session.js";
import type { EstadoMateria } from "../client/types.js";

export async function getEstadoAcademico(session: AutogestionSession): Promise<EstadoMateria[]> {
    return (await session.getConnector()).estadoAcademico();
}
