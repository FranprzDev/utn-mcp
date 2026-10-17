/** Página mínima: se abre desde el celu, así que nada más que lo necesario. */
export function page(title: string, body: string): string {
    return (
        `<!doctype html><html lang="es"><head><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>` +
        "<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem;" +
        "line-height:1.5;color:#1a1a1a;background:#fff}@media(prefers-color-scheme:dark){body{color:#eee;" +
        "background:#151515}}form{display:flex;flex-direction:column;gap:1rem;margin:1.5rem 0}" +
        "button{padding:.7rem;font-size:1rem}label{display:flex;flex-direction:column;gap:.3rem}" +
        "input{padding:.6rem;font-size:1rem}.nota{opacity:.7;font-size:.9rem}.error{color:#d9534f}</style></head>" +
        `<body><h1>${escapeHtml(title)}</h1>${body}</body></html>`
    );
}

export const escapeHtml = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
