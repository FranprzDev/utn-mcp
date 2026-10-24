// Regresiones del pack de estudio: filtro administrativo de dos páginas, topes por env y
// nombres de salida que nunca se pisan.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { adminPattern, capFromEnv, writePackFile } from "../build/aula-virtual/format/study-pack.js";

const makePdf = async (texts) => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (const t of texts) {
        const page = doc.addPage([595, 842]);
        if (t) page.drawText(t, { x: 50, y: 750, size: 12, font });
    }
    return new Uint8Array(await doc.save());
};

test("el filtro detecta material administrativo en la página 2", async () => {
    const bytes = await makePdf(["", "CRONOGRAMA DE CURSADA 2026"]);
    assert.equal(await adminPattern(bytes, "a.pdf"), "cronograma");
});

test("el filtro conserva un apunte cuya palabra clave aparece recién en la página 3", async () => {
    const bytes = await makePdf(["apunte de clase", "ejercicios", "CRONOGRAMA al final"]);
    assert.equal(await adminPattern(bytes, "b.pdf"), null);
});

test("el filtro conserva un PDF sin coincidencias", async () => {
    const bytes = await makePdf(["Introducción a los sistemas de control", "realimentación negativa"]);
    assert.equal(await adminPattern(bytes, "c.pdf"), null);
});

test("capFromEnv vuelve al default con valores inválidos", () => {
    assert.equal(capFromEnv(undefined, 150), 150);
    assert.equal(capFromEnv("abc", 150), 150);
    assert.equal(capFromEnv("0", 150), 150);
    assert.equal(capFromEnv("-3", 150), 150);
    assert.equal(capFromEnv("50", 150), 50);
});

test("writePackFile nunca pisa un pack, ni en el mismo segundo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "utn-mcp-packtest-"));
    const a = await writePackFile(dir, "MAT", new Uint8Array([1, 2, 3]));
    const b = await writePackFile(dir, "MAT", new Uint8Array([4, 5, 6]));
    const c = await writePackFile(dir, "MAT", new Uint8Array([7]));
    assert.notEqual(a, b);
    assert.notEqual(b, c);
    assert.equal((await readFile(a))[0], 1);
    assert.equal((await readFile(b))[0], 4);
    assert.equal((await readFile(c))[0], 7);
    assert.equal((await readdir(dir)).length, 3);
});
