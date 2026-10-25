import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { PLAN_DATA_SOURCE, SISTEMAS_PLANS } from "./data.js";
import { computeRegularityLossImpact } from "./impact.js";
import { matchSubject, tokenizeSubjectName } from "./match.js";
import { readProfile, writeProfile } from "./profile.js";

const json = (data: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
});

const failure = (e: unknown) => ({
    content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }],
    isError: true,
});

const READ_ONLY = { readOnlyHint: true, openWorldHint: false };

const SISTEMAS = "Ingeniería en Sistemas de Información";
const PLANS = Object.keys(SISTEMAS_PLANS).sort();

const NOT_CALCULATED: Record<string, string[]> = {
    "2008": [
        "Proyecto Final: la condición \"para rendir: todas\" las materias no está calculada.",
        "Habilitación Profesional: el requisito de Redes de Datos (materia del plan 2023) no está cargado.",
    ],
    "2023": [
        "Seminario Integrador y Proyecto Final: la condición \"aprobar todas las asignaturas previas\" no está calculada.",
        "Para rendir, las 36 materias base no tienen reglas cargadas (solo las electivas).",
        "Agilidad y Gestión de Productos Digitales y Testing Automatizado: la alternativa para quien cambió de plan sin cursar Diseño de Sistemas de Información no está calculada.",
    ],
};

const SAVE_UNAVAILABLE =
    "El perfil solo se guarda en modo local (STDIO). En el modo HTTP todavía no hay perfil por usuario: pasá `plan` en cada consulta.";

function isSistemas(carrera: string): boolean {
    const tokens = tokenizeSubjectName(carrera);
    return tokens.includes("sistema") || (tokens.length === 1 && tokens[0] === "isi");
}

function normalizePlan(plan: string): string | undefined {
    const year = /\b(2008|2023)\b/.exec(plan)?.[1];
    return year && year in SISTEMAS_PLANS ? year : undefined;
}

export function registerPlanTools(server: McpServer, profileEnabled: boolean) {
    server.registerTool(
        "plan_get_profile",
        {
            description:
                "Devuelve la carrera y el plan de estudios que el usuario tiene guardados (archivo profile.md). " +
                "Usala antes de preguntarle la carrera o el plan. Si no hay nada guardado, preguntáselos y guardalos con plan_set_profile. " +
                "No contiene el historial de materias.",
            annotations: READ_ONLY,
        },
        async () => {
            try {
                if (!profileEnabled) return json({ guardado: false, motivo: SAVE_UNAVAILABLE });
                const profile = await readProfile();
                return json({ guardado: Boolean(profile.carrera || profile.plan), ...profile });
            } catch (e) {
                return failure(e);
            }
        },
    );

    server.registerTool(
        "plan_set_profile",
        {
            description:
                "Guarda la carrera y el plan del usuario en su profile.md local, para no preguntarlos de nuevo. " +
                "Usala cuando el usuario te diga su carrera y plan, y también cuando diga que se cambió de plan: " +
                "actualizá el perfil ANTES de calcular nada con plan_recursar_impacto. " +
                `Por ahora hay datos solo de ${SISTEMAS} (planes ${PLANS.join(" y ")}).`,
            inputSchema: {
                carrera: z.string().describe(`Carrera, por ejemplo "${SISTEMAS}" o "Sistemas".`),
                plan: z.string().describe(`Año del plan de estudios, por ejemplo "2008" o "2023".`),
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        async ({ carrera, plan }) => {
            try {
                if (!profileEnabled) throw new Error(SAVE_UNAVAILABLE);
                if (!isSistemas(carrera)) {
                    throw new Error(`Por ahora solo hay datos de ${SISTEMAS}. No guardé el perfil con "${carrera}".`);
                }
                const normalized = normalizePlan(plan);
                if (!normalized) {
                    throw new Error(`Los planes disponibles son ${PLANS.join(" y ")}. No guardé el perfil con "${plan}".`);
                }
                await writeProfile({ carrera: SISTEMAS, plan: normalized });
                return json({ guardado: true, carrera: SISTEMAS, plan: normalized });
            } catch (e) {
                return failure(e);
            }
        },
    );

    server.registerTool(
        "plan_recursar_impacto",
        {
            description:
                "Calcula con las correlativas oficiales del plan qué materias deja de poder cursar quien recursa una materia " +
                "(pierde su regularidad): `cortaDirectamente` (la materia era requisito regular), `afectaDespuesPorCadena` " +
                "(las que dependen de las anteriores), `yaExigiaAprobada` (necesitaban la materia aprobada, no cambian) y " +
                "`finalesQueExigenAprobada`; todo ordenado por nivel. Usala siempre que pregunte qué le corta o qué materias " +
                "pierde por recursar algo; no lo deduzcas vos. Si devuelve `resultado: \"ambigua\"`, preguntale cuál de las `opciones` " +
                "quiso decir y volvé a llamar con el nombre exacto; no elijas. Si devuelve `no_encontrada`, ofrecé las `cercanas`. " +
                "El plan sale de `plan` o del perfil guardado; si el usuario dice que cambió de plan, actualizá el perfil antes. " +
                "No usa el historial del alumno: son las materias que dependen de esa en el plan, sin saber cuáles ya cursó. " +
                "No inferas cuatrimestres ni años. Respetá `noCalculado`: son reglas que faltan, no las des por cumplidas.",
            inputSchema: {
                materia: z.string().min(1).max(120).describe('Materia que recursa, como la escribió el usuario, por ejemplo "Diseño de Sistemas" o "estructura de datos".'),
                plan: z.string().optional().describe('Plan de estudios, por ejemplo "2008". Si falta se usa el del perfil guardado.'),
            },
            annotations: READ_ONLY,
        },
        async ({ materia, plan }) => {
            try {
                let planYear: string | undefined;
                let origenPlan: "parametro" | "perfil" = "parametro";
                if (plan !== undefined) {
                    planYear = normalizePlan(plan);
                    if (!planYear) throw new Error(`Los planes disponibles son ${PLANS.join(" y ")}. "${plan}" no es uno de ellos.`);
                } else if (profileEnabled) {
                    const profile = await readProfile();
                    if (profile.carrera && !isSistemas(profile.carrera)) {
                        throw new Error(`Por ahora solo hay datos de ${SISTEMAS}; tu perfil dice "${profile.carrera}".`);
                    }
                    planYear = profile.plan ? normalizePlan(profile.plan) : undefined;
                    origenPlan = "perfil";
                }
                if (!planYear) {
                    throw new Error(
                        `No sé de qué plan es. Preguntale al usuario si está en el plan ${PLANS.join(" o ")} de ${SISTEMAS}` +
                            (profileEnabled ? " y guardalo con plan_set_profile." : " y pasalo en `plan`."),
                    );
                }

                const subjects = SISTEMAS_PLANS[planYear];
                const match = matchSubject(materia, subjects);
                const base = { carrera: SISTEMAS, plan: planYear, origenPlan };
                if (match.kind === "ambiguous") {
                    return json({
                        ...base,
                        resultado: "ambigua",
                        opciones: match.candidates.map((s) => ({ nombre: s.name, nivel: s.level })),
                    });
                }
                if (match.kind === "not_found") {
                    return json({
                        ...base,
                        resultado: "no_encontrada",
                        cercanas: match.suggestions.map((s) => ({ nombre: s.name, nivel: s.level })),
                    });
                }
                return json({
                    ...base,
                    resultado: "calculado",
                    ...computeRegularityLossImpact(match.subject, subjects),
                    historialDelAlumno: "no usado",
                    noCalculado: NOT_CALCULATED[planYear],
                    fuente: `${PLAN_DATA_SOURCE.repository}/tree/${PLAN_DATA_SOURCE.commit}`,
                });
            } catch (e) {
                return failure(e);
            }
        },
    );
}
