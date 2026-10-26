import { HttpError } from "../../shared/http.js";
import type { AutogestionSession } from "../client/session.js";
import { columnIndex, tableWithHeaders } from "./parse-table.js";

export interface EstadoMateria {
    materia: string;
    estado?: string;
    plan?: string;
    anio?: string;
    nota?: string;
    fecha?: string;
    extra?: string[];
}

export async function getEstadoAcademico(session: AutogestionSession): Promise<EstadoMateria[]> {
    const connector = await session.getConnector();
    const html = await connector.fetchEstadoAcademico();
    const table = tableWithHeaders(html, ["materia", "estado"]);
    if (!table) {
        throw new HttpError(
            "La página de estado académico de Sysacad no trajo la tabla esperada (materia/estado): " +
                "puede haber cambiado el layout. El parser está en src/autogestion/format/estado-academico.ts.",
        );
    }
    const col = (k: string) => columnIndex(table, k);
    const [materia, estado, plan, anio, nota, fecha] = [
        col("materia"),
        col("estado"),
        col("plan"),
        col("año"),
        col("nota"),
        col("fecha"),
    ];
    const known = new Set([materia, estado, plan, anio, nota, fecha].filter((i) => i >= 0));
    return table.rows.map((cells) => {
        const entry: EstadoMateria = { materia: cells[materia] ?? "" };
        if (estado >= 0) entry.estado = cells[estado] || undefined;
        if (plan >= 0) entry.plan = cells[plan] || undefined;
        if (anio >= 0) entry.anio = cells[anio] || undefined;
        if (nota >= 0) entry.nota = cells[nota] || undefined;
        if (fecha >= 0) entry.fecha = cells[fecha] || undefined;
        const extra = cells.filter((_, i) => !known.has(i) && cells[i]);
        if (extra.length > 0) entry.extra = extra;
        return entry;
    });
}
