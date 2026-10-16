import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { storeFile, storeKeyFile } from "../paths.js";
import type { IssuedToken, SessionStore, TokenKind } from "./session-store.js";

const SCHEMA = `
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        utn_username TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tokens (
        hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
        client_id TEXT,
        expires_at INTEGER,
        created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tokens_user ON tokens(user_id);
    CREATE TABLE IF NOT EXISTS platform_sessions (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        platform TEXT NOT NULL,
        data BLOB NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, platform)
    );
`;

/** Bytes de la clave AES-256. */
const KEY_BYTES = 32;
/** Bytes del IV de AES-GCM. */
const IV_BYTES = 12;
/** Bytes del tag de autenticación de AES-GCM. */
const TAG_BYTES = 16;

const now = () => Math.floor(Date.now() / 1000);
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * El SessionStore sobre SQLite. Las sesiones van cifradas con AES-256-GCM: tienen el token de Moodle
 * y las cookies del SSO, que alcanzan para entrar al aula como el usuario. Los tokens se guardan
 * hasheados, así que una copia de la base no sirve para usar el servidor.
 */
export class SqliteStore implements SessionStore {
    private constructor(
        private readonly db: DatabaseSync,
        private readonly key: Buffer,
    ) {}

    /** `node:sqlite` llega con Node 22.13; se importa acá para que el modo STDIO siga andando en Node 20. */
    static async open(path = storeFile()): Promise<SqliteStore> {
        let sqlite: typeof import("node:sqlite");
        try {
            sqlite = await import("node:sqlite");
        } catch {
            throw new Error(`El modo HTTP necesita Node 22.13 o más nuevo; tenés ${process.version}.`);
        }
        await mkdir(dirname(path), { recursive: true });
        const db = new sqlite.DatabaseSync(path);
        // WAL: el login escribe mientras el servidor lee, desde otro proceso.
        db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
        db.exec(SCHEMA);
        return new SqliteStore(db, await loadKey());
    }

    async findOrCreateUser(utnUsername: string): Promise<number> {
        const username = utnUsername.trim().toLowerCase();
        this.db
            .prepare("INSERT INTO users (utn_username, created_at) VALUES (?, ?) ON CONFLICT DO NOTHING")
            .run(username, now());
        const row = this.db.prepare("SELECT id FROM users WHERE utn_username = ?").get(username) as { id: number };
        return row.id;
    }

    async issueToken(
        userId: number,
        options: { kind: TokenKind; clientId?: string; ttlSeconds?: number },
    ): Promise<string> {
        const token = randomBytes(32).toString("base64url");
        const createdAt = now();
        this.db
            .prepare(
                "INSERT INTO tokens (hash, user_id, kind, client_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .run(
                hashToken(token),
                userId,
                options.kind,
                options.clientId ?? null,
                options.ttlSeconds ? createdAt + options.ttlSeconds : null,
                createdAt,
            );
        return token;
    }

    async findToken(token: string, kind: TokenKind): Promise<IssuedToken | null> {
        const row = this.db
            .prepare(
                "SELECT user_id, client_id, expires_at FROM tokens " +
                    "WHERE hash = ? AND kind = ? AND (expires_at IS NULL OR expires_at > ?)",
            )
            .get(hashToken(token), kind, now()) as
            | { user_id: number; client_id: string | null; expires_at: number | null }
            | undefined;
        return row ? { userId: row.user_id, clientId: row.client_id, expiresAt: row.expires_at } : null;
    }

    async revokeToken(token: string): Promise<void> {
        this.db.prepare("DELETE FROM tokens WHERE hash = ?").run(hashToken(token));
    }

    async loadSession(userId: number, platform: string): Promise<string | null> {
        const row = this.db
            .prepare("SELECT data FROM platform_sessions WHERE user_id = ? AND platform = ?")
            .get(userId, platform) as { data: Uint8Array } | undefined;
        return row ? this.decrypt(row.data) : null;
    }

    async saveSession(userId: number, platform: string, data: string): Promise<void> {
        this.db
            .prepare(
                "INSERT INTO platform_sessions (user_id, platform, data, updated_at) VALUES (?, ?, ?, ?) " +
                    "ON CONFLICT (user_id, platform) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
            )
            .run(userId, platform, this.encrypt(data), now());
    }

    /** iv + tag + texto cifrado, en un solo blob. */
    private encrypt(plain: string): Buffer {
        const iv = randomBytes(IV_BYTES);
        const cipher = createCipheriv("aes-256-gcm", this.key, iv);
        const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), body]);
    }

    private decrypt(blob: Uint8Array): string {
        const buf = Buffer.from(blob);
        const decipher = createDecipheriv("aes-256-gcm", this.key, buf.subarray(0, IV_BYTES));
        decipher.setAuthTag(buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
        try {
            return Buffer.concat([decipher.update(buf.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
        } catch {
            throw new Error("No se pudo descifrar la sesión: la clave (UTN_MCP_KEY o store.key) no es la que la cifró.");
        }
    }
}

/**
 * UTN_MCP_KEY (32 bytes en base64) en el servidor hosteado, donde la clave no tiene que estar en el
 * mismo disco que la base. En local, si no está, se genera una en la carpeta de configuración.
 */
async function loadKey(): Promise<Buffer> {
    const fromEnv = process.env.UTN_MCP_KEY;
    if (fromEnv) {
        const key = Buffer.from(fromEnv, "base64");
        if (key.length !== KEY_BYTES) throw new Error(`UTN_MCP_KEY tiene que ser de ${KEY_BYTES} bytes en base64.`);
        return key;
    }

    const file = storeKeyFile();
    try {
        return Buffer.from((await readFile(file, "utf8")).trim(), "base64");
    } catch {
        const key = randomBytes(KEY_BYTES);
        await mkdir(dirname(file), { recursive: true });
        // `wx`: si otro proceso la creó recién, no la pisamos.
        await writeFile(file, key.toString("base64"), { mode: 0o600, flag: "wx" }).catch(() => {});
        await chmod(file, 0o600).catch(() => {}); // no-op en Windows
        return Buffer.from((await readFile(file, "utf8")).trim(), "base64");
    }
}
