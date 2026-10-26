import { HttpError } from "../../shared/http.js";
import type { AutogestionSession } from "../client/session.js";
import { columnIndex, tableWithHeaders } from "./parse-table.js";

export interface ExamenMateria {
    materia: string;
    fecha?: string;
    nota?: string;
    especialidad?: string;
    plan?: string;
    codigo?: string;
}

export async function getExamenes(session: AutogestionSession): Promise<ExamenMateria[]> {
    const connector = await session.getConnector();
    if (!connector.fetchExamenes) {
        throw new HttpError(
            "El conector de este sistema todavía no sabe leer la página de exámenes. " +
                "El mapeo está en src/autogestion/format/examenes.ts.",
        );
    }
    const html = await connector.fetchExamenes();
    const table = tableWithHeaders(html, ["materia", "nota", "fecha"]);
    if (!table) {
        throw new HttpError(
            "La página de exámenes de Sysacad no trajo la tabla esperada (fecha/materia/nota): " +
                "puede haber cambiado el layout. El parser está en src/autogestion/format/examenes.ts.",
        );
    }
    const col = (k: string) => columnIndex(table, k);
    const [fecha, materia, nota, especialidad, plan, codigo] = [
        col("fecha"),
        col("materia"),
        col("nota"),
        col("especialidad"),
        col("plan"),
        col("código"),
    ];
    return table.rows.map((cells) => {
        const entry: ExamenMateria = { materia: cells[materia] ?? "" };
        if (fecha >= 0) entry.fecha = cells[fecha] || undefined;
        if (nota >= 0) entry.nota = cells[nota] || undefined;
        if (especialidad >= 0) entry.especialidad = cells[especialidad] || undefined;
        if (plan >= 0) entry.plan = cells[plan] || undefined;
        if (codigo >= 0) entry.codigo = cells[codigo] || undefined;
        return entry;
    });
}
