import { openDocument } from "../../shared/documents/index.js";

const ADMIN_PATTERNS = [/cronograma/i, /programa anal[ií]tico/i, /bibliograf[ií]a/i, /formato de presentaci[oó]n/i, /presentaci[oó]n de los trabajos/i];
const ADMIN_SCAN_CHARS = 300;
const ADMIN_SCAN_PAGES = 2;

export async function adminPattern(bytes: Uint8Array, filename: string): Promise<string | null> {
    try {
        const doc = await openDocument(bytes.slice(), filename);
        try {
            if (doc.format !== "pdf") return null;
            for (let page = 1; page <= Math.min(doc.total, ADMIN_SCAN_PAGES); page++) {
                const part = await doc.part(page);
                if (!("text" in part)) continue;
                const head = part.text.slice(0, ADMIN_SCAN_CHARS);
                const hit = ADMIN_PATTERNS.find((p) => p.test(head));
                if (hit) return hit.source;
            }
            return null;
        } finally {
            await doc.close();
        }
    } catch {
        return null;
    }
}
