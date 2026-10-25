const ROMAN_NUMERALS: Record<string, string> = { "1": "i", "2": "ii", "3": "iii", "4": "iv", "5": "v" };
const STOP_WORDS = new Set(["de", "del", "la", "las", "el", "los", "y", "e", "en", "a", "para", "materia"]);
const MAX_SUGGESTIONS = 5;

export interface Matchable {
    number: number;
    name: string;
}

export type SubjectMatch<T extends Matchable> =
    | { kind: "found"; subject: T }
    | { kind: "ambiguous"; candidates: T[] }
    | { kind: "not_found"; suggestions: T[] };

function stem(token: string): string {
    if (token.length > 4 && token.endsWith("es")) return token.slice(0, -2);
    if (token.length > 3 && token.endsWith("s")) return token.slice(0, -1);
    return token;
}

/** Minúsculas, sin tildes ni artículos, con plurales reducidos y números como romanos ("Física 1" = "Física I"). */
export function tokenizeSubjectName(value: string): string[] {
    return value
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .split(" ")
        .filter((token) => token.length > 0 && !STOP_WORDS.has(token))
        .map((token) => stem(ROMAN_NUMERALS[token] ?? token));
}

function isPrefixMatch(queryToken: string, subjectToken: string): boolean {
    return queryToken === subjectToken || (queryToken.length >= 4 && subjectToken.startsWith(queryToken));
}

function coversAll(queryTokens: readonly string[], subjectTokens: readonly string[]): boolean {
    return queryTokens.every((q) => subjectTokens.some((s) => isPrefixMatch(q, s)));
}

function overlap(queryTokens: readonly string[], subjectTokens: readonly string[]): number {
    const shared = queryTokens.filter((q) => subjectTokens.some((s) => isPrefixMatch(q, s)));
    return shared.length / new Set([...queryTokens, ...subjectTokens]).size;
}

/** Un solo match se usa; varios se devuelven como ambiguos para preguntar, nunca se elige entre ellos. */
export function matchSubject<T extends Matchable>(query: string, subjects: readonly T[]): SubjectMatch<T> {
    const queryTokens = tokenizeSubjectName(query);
    if (queryTokens.length === 0) return { kind: "not_found", suggestions: [] };

    const tokenized = subjects.map((subject) => ({ subject, tokens: tokenizeSubjectName(subject.name) }));
    const exact = tokenized.filter(
        ({ tokens }) => tokens.length === queryTokens.length && tokens.every((token, i) => token === queryTokens[i]),
    );
    if (exact.length === 1) return { kind: "found", subject: exact[0].subject };

    const covering = tokenized.filter(({ tokens }) => coversAll(queryTokens, tokens));
    if (covering.length === 1) return { kind: "found", subject: covering[0].subject };
    if (covering.length > 1) return { kind: "ambiguous", candidates: covering.map(({ subject }) => subject) };

    const suggestions = tokenized
        .map(({ subject, tokens }) => ({ subject, score: overlap(queryTokens, tokens) }))
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score || a.subject.number - b.subject.number)
        .slice(0, MAX_SUGGESTIONS)
        .map(({ subject }) => subject);
    return { kind: "not_found", suggestions };
}
