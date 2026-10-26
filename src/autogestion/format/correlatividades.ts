import type { AutogestionSession } from "../client/session.js";
import type { Correlatividades } from "../client/types.js";

export async function getCorrelatividades(session: AutogestionSession): Promise<Correlatividades> {
    return (await session.getConnector()).correlatividades();
}
