import { PDFDocument, StandardFonts } from "pdf-lib";

/** Un PDF a unir, con el nombre con que aparece en el índice. */
export interface MergeInput {
    title: string;
    bytes: Uint8Array;
}

export interface MergedFile {
    /** El índice del archivo en la lista de entrada, para reconocerlo después. */
    index: number;
    title: string;
    /** Página del PDF unido en la que empieza, numerada desde 1 (contando el índice). */
    startPage: number;
    pages: number;
}

export interface SkippedFile {
    index: number;
    title: string;
    reason: string;
}

/** Filas del índice que entran en una página A4 con letra de 11pt. */
const INDEX_ROWS_PER_PAGE = 40;

/**
 * Une PDFs en uno solo, con un índice al principio que dice en qué página empieza cada uno.
 * El que no se puede abrir (roto o con clave) se salta y queda en `skipped`: pdf-lib no
 * desencripta, así que un PDF con clave entraría con páginas rotas. El índice se arma al
 * final, cuando se sabe qué archivos entraron, y se inserta al frente.
 */
export async function mergePdfs(
    files: MergeInput[],
    documentTitle?: string,
): Promise<{ bytes: Uint8Array; pages: number; merged: MergedFile[]; skipped: SkippedFile[] }> {
    const out = await PDFDocument.create();
    if (documentTitle) out.setTitle(documentTitle);

    const merged: Omit<MergedFile, "startPage">[] = [];
    /** En qué página empieza cada uno sin contar el índice, que todavía no se sabe cuánto ocupa. */
    const contentStarts: number[] = [];
    const skipped: SkippedFile[] = [];

    for (let index = 0; index < files.length; index++) {
        const file = files[index];
        let src: PDFDocument;
        try {
            // ignoreEncryption solo para que `load` no rechace el archivo: así lo listamos
            // en `skipped` con el motivo en vez de romper todo el pack.
            src = await PDFDocument.load(file.bytes, { ignoreEncryption: true });
        } catch {
            skipped.push({ index, title: file.title, reason: "no se pudo abrir (está roto)" });
            continue;
        }
        if (src.isEncrypted) {
            skipped.push({ index, title: file.title, reason: "tiene clave" });
            continue;
        }
        let pages;
        try {
            pages = await out.copyPages(src, src.getPageIndices());
        } catch {
            // Abre bien pero tiene objetos que no se pueden copiar: se salta como los rotos.
            skipped.push({ index, title: file.title, reason: "no se pudieron copiar sus páginas" });
            continue;
        }
        if (!pages.length) {
            skipped.push({ index, title: file.title, reason: "no tiene páginas" });
            continue;
        }
        contentStarts.push(out.getPageCount() + 1);
        for (const page of pages) out.addPage(page);
        merged.push({ index, title: file.title, pages: pages.length });
    }

    if (!merged.length) throw new Error("No se pudo unir ninguno de los PDF.");

    const indexPages = Math.ceil(merged.length / INDEX_ROWS_PER_PAGE);
    const withStart = merged.map((m, i) => ({ ...m, startPage: contentStarts[i] + indexPages }));
    await writeIndex(out, withStart, indexPages);

    const bytes = await out.save();
    return { bytes, pages: out.getPageCount(), merged: withStart, skipped };
}

/** Escribe las páginas del índice y las inserta al frente, en orden. */
async function writeIndex(out: PDFDocument, merged: MergedFile[], indexPages: number): Promise<void> {
    const font = await out.embedFont(StandardFonts.Helvetica);
    const bold = await out.embedFont(StandardFonts.HelveticaBold);
    const pageSize: [number, number] = [595, 842]; // A4
    const margin = 50;
    const lineHeight = 16;

    for (let n = 0; n < indexPages; n++) {
        const page = out.insertPage(n, pageSize);
        let y = pageSize[1] - margin;
        page.drawText(winAnsi("Índice"), { x: margin, y, size: 16, font: bold });
        y -= lineHeight * 2;

        const rows = merged.slice(n * INDEX_ROWS_PER_PAGE, (n + 1) * INDEX_ROWS_PER_PAGE);
        for (const row of rows) {
            const pageNo = String(row.startPage);
            page.drawText(pageNo, { x: margin + 30 - font.widthOfTextAtSize(pageNo, 11), y, size: 11, font });
            page.drawText(truncate(winAnsi(row.title), font, 11, pageSize[0] - margin * 2 - 40), {
                x: margin + 40,
                y,
                size: 11,
                font,
            });
            y -= lineHeight;
        }
    }
}

/** Lo que la letra base del PDF sabe dibujar (WinAnsi); lo demás se cambia por "?". */
const winAnsi = (text: string) =>
    text.replace(/[^\x20-\x7E\xA0-\xFF\u2013\u2014\u2018\u2019\u201C\u201D\u2022\u2026]/g, "?");

/** Recorta el título para que entre en el renglón, con "…" si se cortó. */
function truncate(text: string, font: { widthOfTextAtSize(t: string, s: number): number }, size: number, maxWidth: number): string {
    if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
    let cut = text;
    while (cut && font.widthOfTextAtSize(cut + "…", size) > maxWidth) cut = cut.slice(0, -1);
    return cut + "…";
}
