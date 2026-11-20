import { createHash } from "node:crypto";

/**
 * Cliente mínimo de la API REST de GitHub para publicar archivos en una rama y abrir un PR.
 * El token sale solo de GITHUB_TOKEN en el entorno y va únicamente a api.github.com.
 */
const API = "https://api.github.com";

export interface GithubRepoRef {
    defaultBranch: string;
    headSha: string;
}

export interface GithubCommittedFile {
    path: string;
    blobSha: string;
    verified: boolean;
}

function token(): string {
    const t = process.env.GITHUB_TOKEN;
    if (!t) throw new Error("Falta GITHUB_TOKEN en el entorno del servidor (un token con acceso al repo).");
    return t;
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${API}${path}`, {
        method,
        headers: {
            authorization: `Bearer ${token()}`,
            accept: "application/vnd.github+json",
            "content-type": "application/json",
            "x-github-api-version": "2022-11-28",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
    });
    const data = (await res.json().catch(() => ({}))) as { message?: string; errors?: { message?: string }[] };
    if (!res.ok) {
        const detail = data.message ?? data.errors?.[0]?.message ?? "";
        throw new Error(`GitHub ${method} ${path} falló: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
    }
    return data as T;
}

/** El sha del blob git de un contenido: así verificamos que GitHub guardó exactamente los bytes bajados. */
export function gitBlobSha(bytes: Uint8Array): string {
    return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

export async function getRepoRef(repo: string): Promise<GithubRepoRef> {
    const info = await api<{ default_branch: string }>("GET", `/repos/${repo}`);
    const ref = await api<{ object: { sha: string } }>(
        "GET",
        `/repos/${repo}/git/ref/heads/${info.default_branch}`,
    );
    return { defaultBranch: info.default_branch, headSha: ref.object.sha };
}

export async function createBranch(repo: string, branch: string, fromSha: string): Promise<void> {
    try {
        await api("POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: fromSha });
    } catch (e) {
        if ((e as Error).message.includes("Reference already exists")) {
            throw new Error(
                `La rama "${branch}" ya existe en ${repo}. Elegí otra con \`rama\` o borrala si quedó de un intento anterior.`,
            );
        }
        throw e;
    }
}

/** Sube un archivo a la rama (contents API: guarda los bytes exactos) y verifica el blob sha. */
export async function putFile(
    repo: string,
    branch: string,
    path: string,
    bytes: Uint8Array,
    message: string,
): Promise<GithubCommittedFile> {
    const res = await api<{ content: { sha: string } }>("PUT", `/repos/${repo}/contents/${path}`, {
        message,
        content: Buffer.from(bytes).toString("base64"),
        branch,
    });
    const expected = gitBlobSha(bytes);
    return { path, blobSha: res.content.sha, verified: res.content.sha === expected };
}

export async function createPullRequest(
    repo: string,
    head: string,
    base: string,
    title: string,
    body: string,
): Promise<{ url: string; number: number }> {
    try {
        const pr = await api<{ html_url: string; number: number }>("POST", `/repos/${repo}/pulls`, {
            title,
            body,
            head,
            base,
        });
        return { url: pr.html_url, number: pr.number };
    } catch (e) {
        if ((e as Error).message.includes("A pull request already exists")) {
            throw new Error(`Ya hay un PR abierto para la rama "${head}" en ${repo}.`);
        }
        throw e;
    }
}
