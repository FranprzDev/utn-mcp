import { PDFArray, PDFDocument, PDFName, StandardFonts, degrees, rgb, type PDFFont, type PDFPage } from "pdf-lib";

export interface MergeInput {
    title: string;
    bytes: Uint8Array;
}

export interface MergedFile {
    index: number;
    title: string;
    startPage: number;
    pages: number;
}

export interface SkippedFile {
    index: number;
    title: string;
    reason: string;
}

const INDEX_ROWS_PER_PAGE = 40;

const BACK_STRIP = 18;
const BACK_LABEL = "Volver al índice";

function addPageLink(out: PDFDocument, page: PDFPage, rect: [number, number, number, number], dest: PDFPage): void {
    const link = out.context.register(
        out.context.obj({
            Type: "Annot",
            Subtype: "Link",
            Rect: rect,
            Border: [0, 0, 0],
            Dest: [dest.ref, "Fit"],
        }),
    );
    let annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    if (!annots) {
        annots = out.context.obj([]);
        page.node.set(PDFName.of("Annots"), annots);
    }
    annots.push(link);
}

export async function mergePdfs(
    files: MergeInput[],
    documentTitle?: string,
): Promise<{ bytes: Uint8Array; pages: number; merged: MergedFile[]; skipped: SkippedFile[] }> {
    const out = await PDFDocument.create();
    if (documentTitle) out.setTitle(documentTitle);

    const merged: Omit<MergedFile, "startPage">[] = [];
    const contentStarts: number[] = [];
    const skipped: SkippedFile[] = [];

    for (let index = 0; index < files.length; index++) {
        const file = files[index];
        let src: PDFDocument;
        try {
            src = await PDFDocument.load(file.bytes, { ignoreEncryption: true });
        } catch {
            skipped.push({ index, title: file.title, reason: "no se pudo abrir (está roto)" });
            continue;
        }
        if (src.isEncrypted) {
            skipped.push({ index, title: file.title, reason: "tiene clave" });
            continue;
        }
        let pages: PDFPage[];
        try {
            pages = await out.copyPages(src, src.getPageIndices());
        } catch {
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
    const font = await out.embedFont(StandardFonts.Helvetica);
    await writeIndex(out, withStart, indexPages, font);
    addBackLinks(out, indexPages, font);

    const bytes = await out.save();
    return { bytes, pages: out.getPageCount(), merged: withStart, skipped };
}

async function writeIndex(out: PDFDocument, merged: MergedFile[], indexPages: number, font: PDFFont): Promise<void> {
    const bold = await out.embedFont(StandardFonts.HelveticaBold);
    const pageSize: [number, number] = [595, 842];
    const margin = 50;
    const lineHeight = 16;

    const pendingLinks: { page: PDFPage; rect: [number, number, number, number]; startPage: number }[] = [];

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
            pendingLinks.push({ page, rect: [margin, y - 4, pageSize[0] - margin, y + 11], startPage: row.startPage });
            y -= lineHeight;
        }
    }

    for (const { page, rect, startPage } of pendingLinks) {
        addPageLink(out, page, rect, out.getPage(startPage - 1));
    }
}

function addBackLinks(out: PDFDocument, indexPages: number, font: PDFFont): void {
    const firstIndexPage = out.getPage(0);
    const size = 9;
    const color = rgb(0.1, 0.3, 0.7);
    const textWidth = font.widthOfTextAtSize(BACK_LABEL, size);
    const total = out.getPageCount();
    for (let i = indexPages; i < total; i++) {
        const page = out.getPage(i);
        const media = page.getMediaBox();
        const crop = page.getCropBox();
        const { x: X, y: Y, width: w, height: h } = media;
        const rotation = (((page.getRotation().angle % 360) + 360) % 360) as 0 | 90 | 180 | 270;

        let textX: number, textY: number, lineStart: { x: number; y: number }, lineEnd: { x: number; y: number };
        let strip: [number, number, number, number];
        let rotate: ReturnType<typeof degrees>;
        switch (rotation) {
            case 90:
                page.setMediaBox(X - BACK_STRIP, Y, w + BACK_STRIP, h);
                page.setCropBox(crop.x - BACK_STRIP, crop.y, crop.width + BACK_STRIP, crop.height);
                strip = [X - BACK_STRIP, Y, X, Y + h];
                rotate = degrees(90);
                textX = X - BACK_STRIP + 5 + size;
                textY = Y + h - 30 - textWidth;
                lineStart = { x: textX + 1.5, y: textY };
                lineEnd = { x: textX + 1.5, y: textY + textWidth };
                break;
            case 180:
                page.setMediaBox(X, Y - BACK_STRIP, w, h + BACK_STRIP);
                page.setCropBox(crop.x, crop.y - BACK_STRIP, crop.width, crop.height + BACK_STRIP);
                strip = [X, Y - BACK_STRIP, X + w, Y];
                rotate = degrees(180);
                textX = X + 30 + textWidth;
                textY = Y - BACK_STRIP + 5 + size;
                lineStart = { x: textX, y: textY + 1.5 };
                lineEnd = { x: textX - textWidth, y: textY + 1.5 };
                break;
            case 270:
                page.setMediaBox(X, Y, w + BACK_STRIP, h);
                page.setCropBox(crop.x, crop.y, crop.width + BACK_STRIP, crop.height);
                strip = [X + w, Y, X + w + BACK_STRIP, Y + h];
                rotate = degrees(270);
                textX = X + w + BACK_STRIP - 5 - size;
                textY = Y + 30 + textWidth;
                lineStart = { x: textX - 1.5, y: textY };
                lineEnd = { x: textX - 1.5, y: textY - textWidth };
                break;
            default:
                page.setMediaBox(X, Y, w, h + BACK_STRIP);
                page.setCropBox(crop.x, crop.y, crop.width, crop.height + BACK_STRIP);
                strip = [X, Y + h, X + w, Y + h + BACK_STRIP];
                rotate = degrees(0);
                textX = X + w - 30 - textWidth;
                textY = Y + h + 5;
                lineStart = { x: textX, y: textY - 1.5 };
                lineEnd = { x: textX + textWidth, y: textY - 1.5 };
                break;
        }
        page.drawText(BACK_LABEL, { x: textX, y: textY, size, font, color, rotate });
        page.drawLine({ start: lineStart, end: lineEnd, thickness: 0.5, color });
        addPageLink(out, page, strip, firstIndexPage);
    }
}

const winAnsi = (text: string) =>
    text.replace(/[^\x20-\x7E\xA0-\xFF\u2013\u2014\u2018\u2019\u201C\u201D\u2022\u2026]/g, "?");

function truncate(text: string, font: { widthOfTextAtSize(t: string, s: number): number }, size: number, maxWidth: number): string {
    if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
    let cut = text;
    while (cut && font.widthOfTextAtSize(cut + "…", size) > maxWidth) cut = cut.slice(0, -1);
    return cut + "…";
}
