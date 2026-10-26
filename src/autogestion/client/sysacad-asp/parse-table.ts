import { htmlToText } from "../../../shared/html.js";

export interface ParsedTable {
    headers: string[];
    rows: string[][];
}

export function parseTables(html: string): ParsedTable[] {
    const tables: ParsedTable[] = [];
    for (const tableMatch of html.matchAll(/<table[\s>][\s\S]*?<\/table>/gi)) {
        const rows: string[][] = [];
        for (const rowMatch of tableMatch[0].matchAll(/<tr[\s>][\s\S]*?<\/tr>/gi)) {
            const cells = [...rowMatch[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) =>
                htmlToText(c[1]),
            );
            if (cells.length > 0) rows.push(cells);
        }
        if (rows.length > 2 && rows[0].length < rows[1].length) {
            tables.push({ headers: rows[1], rows: rows.slice(2) });
        } else if (rows.length > 1) {
            tables.push({ headers: rows[0], rows: rows.slice(1) });
        }
    }
    return tables;
}

export function tableWithHeaders(html: string, keywords: string[]): ParsedTable | null {
    const wanted = keywords.map((k) => k.toLowerCase());
    for (const table of parseTables(html)) {
        const headers = table.headers.join(" ").toLowerCase();
        if (wanted.every((w) => headers.includes(w))) return table;
    }
    return null;
}

export function columnIndex(table: ParsedTable, keyword: string): number {
    return table.headers.findIndex((h) => h.toLowerCase().includes(keyword.toLowerCase()));
}
