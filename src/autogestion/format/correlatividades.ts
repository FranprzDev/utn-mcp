import { HttpError } from "../../shared/http.js";
import type { AutogestionSession } from "../client/session.js";
import { columnIndex, tableWithHeaders } from "./parse-table.js";

/** Una materia con las correlativas que exige, tal como las publica la autogestión. */
export interface CorrelatividadMateria {
    materia: string;
    /** Texto de la columna de correlativas, tal cual viene: "X e Y regulares", "Z aprobada", etc. */
    correlativas: string;
    extra?: string[];
}

/**
 * Correlatividades de la carrera según la autogestión: la tabla cuyo encabezado nombra materia y
 * correlatividad. Es la fuente dinámica que el issue #22 quiere en lugar de datos fijos del repo.
 */
export async function getCorrelatividades(session: AutogestionSession): Promise<CorrelatividadMateria[]> {
    const connector = await session.getConnector();
    const html = await connector.fetchCorrelatividades();
    const table = tableWithHeaders(html, ["materia", "correlatividad"]);
    if (!table) {
        throw new HttpError(
            "La página de correlatividades de Sysacad no trajo la tabla esperada (materia/correlatividad): " +
                "puede haber cambiado el layout. El parser está en src/autogestion/format/correlatividades.ts.",
        );
    }
    const materia = columnIndex(table, "materia");
    const correlativas = columnIndex(table, "correlatividad");
    const known = new Set([materia, correlativas].filter((i) => i >= 0));
    return table.rows.map((cells) => {
        const entry: CorrelatividadMateria = {
            materia: cells[materia] ?? "",
            correlativas: cells[correlativas] ?? "",
        };
        const extra = cells.filter((_, i) => !known.has(i) && cells[i]);
        if (extra.length > 0) entry.extra = extra;
        return entry;
    });
}
