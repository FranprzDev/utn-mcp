// Regresión: la descarga del pack solo sigue redirects al propio aula y a rutas de archivos (pluginfile).
// Servidor local + sesión falsa: no toca el aula real ni necesita credenciales.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fetchPackFile } from "../build/aula-virtual/format/study-pack.js";

let server;
let base;
const session = {
    getToken: async () => "TOKEN-FALSO",
    refreshToken: async () => "TOKEN-FALSO",
    getRegional: async () => ({ baseUrl: base }),
};

before(async () => {
    server = createServer((req, res) => {
        const u = new URL(req.url, "http://x");
        switch (u.pathname) {
            case "/webservice/pluginfile.php/ok":
                res.end("PDF-DIRECTO"); return;
            case "/webservice/pluginfile.php/redir-same":
                res.writeHead(302, { location: "/pluginfile.php/mod_resource/content/1/ok" }); res.end(); return;
            case "/pluginfile.php/mod_resource/content/1/ok":
                res.end("PDF-REDIRIGIDO"); return;
            case "/webservice/pluginfile.php/redir-cross":
                res.writeHead(302, { location: "http://127.0.0.2:9/evil" }); res.end(); return;
            case "/webservice/pluginfile.php/redir-badpath":
                res.writeHead(302, { location: "/admin/settings.php" }); res.end(); return;
            case "/webservice/pluginfile.php/redir-loop":
                res.writeHead(302, { location: "/webservice/pluginfile.php/redir-loop" }); res.end(); return;
            default:
                res.writeHead(404); res.end(); return;
        }
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const fetchText = async (path) => {
    const bytes = await fetchPackFile(session, new URL(base + path), 1024 * 1024);
    return Buffer.from(bytes).toString();
};

test("descarga directa funciona", async () => {
    assert.equal(await fetchText("/webservice/pluginfile.php/ok"), "PDF-DIRECTO");
});

test("redirect al propio aula y ruta de archivos se sigue", async () => {
    assert.equal(await fetchText("/webservice/pluginfile.php/redir-same"), "PDF-REDIRIGIDO");
});

test("redirect a otro origen se rechaza", async () => {
    await assert.rejects(fetchText("/webservice/pluginfile.php/redir-cross"), /no permitida/);
});

test("redirect al aula pero fuera de rutas de archivos se rechaza", async () => {
    await assert.rejects(fetchText("/webservice/pluginfile.php/redir-badpath"), /no permitida/);
});

test("loop de redirects se corta al límite", async () => {
    await assert.rejects(fetchText("/webservice/pluginfile.php/redir-loop"), /no permitida/);
});
