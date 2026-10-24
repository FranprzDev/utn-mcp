import { PDFArray, PDFDocument, PDFName, StandardFonts, degrees, rgb, type PDFFont, type PDFPage } from "pdf-lib";

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
 * Alto de la franja que se AGREGA arriba de cada página de contenido para el enlace de
 * vuelta al índice: la página queda un poco más alta, así el enlace nunca tapa el material.
 */
const BACK_STRIP = 18;
const BACK_LABEL = "Volver al índice";

/**
 * Agrega a `page` un enlace rectangular (anotación Link sin borde) que muestra `dest` entera.
 */
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

/**
 * Une PDFs en uno solo, con un índice clickeable al principio: cada entrada abre la página
 * donde empieza ese material, y cada página de contenido tiene arriba un enlace "Volver al
 * índice" (en una franja agregada, sin tapar nada). El que no se puede abrir (roto o con
 * clave) se salta y queda en `skipped`: pdf-lib no desencripta, así que un PDF con clave
 * entraría con páginas rotas. El índice se arma al final, cuando se sabe qué archivos
 * entraron, y se inserta al frente.
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
        let pages: PDFPage[];
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
    const font = await out.embedFont(StandardFonts.Helvetica);
    await writeIndex(out, withStart, indexPages, font);
    addBackLinks(out, indexPages, font);

    const bytes = await out.save();
    return { bytes, pages: out.getPageCount(), merged: withStart, skipped };
}

/** Escribe las páginas del índice y las inserta al frente, con cada renglón enlazado a su material. */
async function writeIndex(out: PDFDocument, merged: MergedFile[], indexPages: number, font: PDFFont): Promise<void> {
    const bold = await out.embedFont(StandardFonts.HelveticaBold);
    const pageSize: [number, number] = [595, 842]; // A4
    const margin = 50;
    const lineHeight = 16;

    // Las anotaciones se agregan después de insertar TODAS las páginas del índice: recién ahí
    // las páginas de contenido quedan en su posición final y se las puede apuntar por índice.
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

/**
 * Agrega a cada página de contenido una franja vacía con "Volver al índice" enlazado a la
 * primera página del índice. La franja AGRANDA la página por el borde que queda arriba al
 * leerla (arriba sin rotación; a la izquierda, abajo o a la derecha según la rotación de la
 * página) y el texto se dibuja ya rotado: se lee horizontal en cualquier orientación y, al
 * ser espacio agregado, nunca tapa el material. Toda la franja es clickeable.
 */
function addBackLinks(out: PDFDocument, indexPages: number, font: PDFFont): void {
    const firstIndexPage = out.getPage(0);
    const size = 9;
    const color = rgb(0.1, 0.3, 0.7);
    const textWidth = font.widthOfTextAtSize(BACK_LABEL, size);
    const total = out.getPageCount();
    for (let i = indexPages; i < total; i++) {
        const page = out.getPage(i);
        // Los dos box se leen ANTES de escribir: sin CropBox propio, getCropBox devuelve el
        // MediaBox, y leerlo después de agrandarlo agrandaría el CropBox dos veces.
        const media = page.getMediaBox();
        const crop = page.getCropBox();
        const { x: X, y: Y, width: w, height: h } = media;
        const rotation = (((page.getRotation().angle % 360) + 360) % 360) as 0 | 90 | 180 | 270;

        // Posición del texto y dirección del subrayado según el borde por donde crece la página.
        let textX: number, textY: number, lineStart: { x: number; y: number }, lineEnd: { x: number; y: number };
        let strip: [number, number, number, number];
        let rotate: ReturnType<typeof degrees>;
        switch (rotation) {
            case 90:
                // Al leerla rotada 90° el borde izquierdo queda arriba: la franja crece a la izquierda.
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
