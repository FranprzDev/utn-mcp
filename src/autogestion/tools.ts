import type { McpServer } from "@modelcontextprotocol/server";
import { systemForRegional } from "./client/connector.js";
import type { AutogestionSession } from "./client/session.js";
import { getCorrelatividades } from "./format/correlatividades.js";
import { getEstadoAcademico } from "./format/estado-academico.js";

// JSON compacto: indentar estas respuestas cuesta ~25% más de contexto y no se lee mejor.
const json = (data: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
});

const failure = (e: unknown) => ({
    content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }],
    isError: true,
});

export function registerAutogestionTools(
    server: McpServer,
    session: AutogestionSession,
    getRegionalId: () => Promise<string>,
) {
    server.registerTool(
        "autogestion_sistema",
        {
            description:
                "Qué sistema de autogestión académica usa la regional del usuario (Sysacad, SIU Guaraní, etc.) y " +
                "si el conector ya está verificado con una cuenta real. Es el punto de entrada de la autogestión: " +
                "si dice que la regional no tiene conector, no insistas con las otras tools autogestion_*.",
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async () => {
            try {
                const regionalId = await getRegionalId();
                const system = systemForRegional(regionalId);
                if (!system) return json({ regional: regionalId, sistema: null });
                return json({ regional: regionalId, sistema: system.id, nombre: system.name, soporte: system.support });
            } catch (e) {
                return failure(e);
            }
        },
    );

    server.registerTool(
        "autogestion_estado_academico",
        {
            description:
                "Estado académico del usuario según la autogestión de su regional: cada materia con su estado " +
                "(regular, aprobada, libre), plan, nota y fecha, tal como los publica el sistema. Requiere " +
                "`utn-mcp login autogestion` una vez; las credenciales son las del sistema de autogestión, " +
                "que no siempre son las del aula virtual.",
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async () => {
            try {
                return json(await getEstadoAcademico(session));
            } catch (e) {
                return failure(e);
            }
        },
    );

    server.registerTool(
        "autogestion_correlatividades",
        {
            description:
                "Correlatividades de la carrera del usuario según la autogestión de su regional: para cada " +
                "materia, qué exige tener regular o aprobada. Es la fuente dinámica de correlatividades: usala " +
                "en lugar de suponer datos de un plan fijo. Requiere `utn-mcp login autogestion` una vez.",
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async () => {
            try {
                return json(await getCorrelatividades(session));
            } catch (e) {
                return failure(e);
            }
        },
    );
}
