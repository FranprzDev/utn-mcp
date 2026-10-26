import { HttpError } from "../../shared/http.js";
import type { AutogestionSession } from "../client/session.js";
import { columnIndex, tableWithHeaders } from "./parse-table.js";

/** Una materia con las correlativas que exige, tal como las publica la autogestión. */
export interface CorrelatividadMateria {
    materia: string;
    /** Texto de la columna de correlativas, tal cual viene: "Puede cursar", "No aprobó X", etc. */
    correlativas: string;
    plan?: string;
    anio?: string;
    extra?: string[];
}

/**
 * Correlatividades de la carrera según la autogestión, separadas como las publica el sistema:
 * `cursar` siempre; `rendir` cuando el sistema la tiene en otra página (Sysacad sí, verificado
 * con cuenta real oct 2026). Es la fuente dinámica que el issue #22 quiere en lugar de datos
 * fijos del repo.
 */
export interface Correlatividades {
    cursar: CorrelatividadMateria[];
    rendir?: CorrelatividadMateria[];
}

/** La tabla de correlatividades de una página: encabezado con materia y correlatividad. */
function parseCorrelatividades(html: string, pagina: string): CorrelatividadMateria[] {
    const table = tableWithHeaders(html, ["materia", "correlatividad"]);
    if (!table) {
        throw new HttpError(
            `La página de correlatividades para ${pagina} de Sysacad no trajo la tabla esperada ` +
                "(materia/correlatividad): puede haber cambiado el layout. " +
                "El parser está en src/autogestion/format/correlatividades.ts.",
        );
    }
    const materia = columnIndex(table, "materia");
    const correlativas = columnIndex(table, "correlatividad");
    const plan = columnIndex(table, "plan");
    const anio = columnIndex(table, "año");
    const known = new Set([materia, correlativas, plan, anio].filter((i) => i >= 0));
    return table.rows.map((cells) => {
        const entry: CorrelatividadMateria = {
            materia: cells[materia] ?? "",
            correlativas: cells[correlativas] ?? "",
        };
        if (plan >= 0) entry.plan = cells[plan] || undefined;
        if (anio >= 0) entry.anio = cells[anio] || undefined;
        const extra = cells.filter((_, i) => !known.has(i) && cells[i]);
        if (extra.length > 0) entry.extra = extra;
        return entry;
    });
}

/** Correlatividades de cursar y, si el conector la publica, de rendir. */
export async function getCorrelatividades(session: AutogestionSession): Promise<Correlatividades> {
    const connector = await session.getConnector();
    const result: Correlatividades = {
        cursar: parseCorrelatividades(await connector.fetchCorrelatividades(), "cursar"),
    };
    if (connector.fetchCorrelatividadesExamen) {
        result.rendir = parseCorrelatividades(await connector.fetchCorrelatividadesExamen(), "rendir");
    }
    return result;
}
