import type { PlanSubject } from "./data.js";

export interface ImpactEntry {
    nombre: string;
    nivel: number;
    electiva?: true;
}

export interface RegularityLossImpact {
    materia: { nombre: string; nivel: number };
    /** Solo se pierde el final si la materia estaba regular y no aprobada. */
    cortaDirectamente: ImpactEntry[];
    afectaDespuesPorCadena: ImpactEntry[];
    yaExigiaAprobada: ImpactEntry[];
    finalesQueExigenAprobada: ImpactEntry[];
}

const byLevelAndNumber = (a: PlanSubject, b: PlanSubject) => a.level - b.level || a.number - b.number;

const toEntry = (s: PlanSubject): ImpactEntry => ({
    nombre: s.name,
    nivel: s.level,
    electiva: s.isElective || undefined,
});

const requiresToTake = (s: PlanSubject, number: number) =>
    s.regularToTake.includes(number) || s.approvedToTake.includes(number);

function collectChain(seeds: readonly PlanSubject[], subjects: readonly PlanSubject[]): PlanSubject[] {
    const reached = new Set(seeds.map((s) => s.number));
    const chain: PlanSubject[] = [];
    const queue = [...seeds];
    while (queue.length > 0) {
        const current = queue.shift() as PlanSubject;
        for (const candidate of subjects) {
            if (reached.has(candidate.number) || !requiresToTake(candidate, current.number)) continue;
            reached.add(candidate.number);
            queue.push(candidate);
            chain.push(candidate);
        }
    }
    return chain.sort(byLevelAndNumber);
}

/** Qué deja de poder cursar quien pierde la regularidad de `root`, en el grafo de correlativas del plan. */
export function computeRegularityLossImpact(root: PlanSubject, subjects: readonly PlanSubject[]): RegularityLossImpact {
    const others = subjects.filter((s) => s.number !== root.number);
    const approvalOnly = others.filter((s) => s.approvedToTake.includes(root.number)).sort(byLevelAndNumber);
    const blockedAnyway = new Set(approvalOnly.map((s) => s.number));
    const reachable = others.filter((s) => !blockedAnyway.has(s.number));
    const direct = reachable.filter((s) => s.regularToTake.includes(root.number)).sort(byLevelAndNumber);
    const chain = collectChain(direct, reachable);
    const finals = others.filter((s) => s.approvedToSit.includes(root.number)).sort(byLevelAndNumber);
    return {
        materia: { nombre: root.name, nivel: root.level },
        cortaDirectamente: direct.map(toEntry),
        afectaDespuesPorCadena: chain.map(toEntry),
        yaExigiaAprobada: approvalOnly.map(toEntry),
        finalesQueExigenAprobada: finals.map(toEntry),
    };
}
