/**
 * Dónde viven los usuarios del modo HTTP, sus tokens y sus sesiones en cada plataforma. El servidor
 * MCP lee (y guarda la sesión cuando la renueva); los usuarios y tokens los crea otro proceso: el
 * login por OAuth de la versión hosteada o `utn-mcp login --http` en local.
 */
export interface SessionStore {
    /** Id del usuario con ese nombre de la UTN; lo crea si no existe. Con `email`, se lo actualiza. */
    findOrCreateUser(utnUsername: string, email?: string): Promise<number>;

    findUser(userId: number): Promise<StoredUser | null>;

    /**
     * Emite un token para el usuario y devuelve el valor en claro: se muestra una sola vez, en la base
     * queda solo el hash. Sin `ttlSeconds` no vence (el token fijo del modo local).
     */
    issueToken(userId: number, options: { kind: TokenKind; clientId?: string; ttlSeconds?: number }): Promise<string>;

    /** El token si es de ese tipo y está vigente; si no, null. */
    findToken(token: string, kind: TokenKind): Promise<IssuedToken | null>;

    revokeToken(token: string): Promise<void>;

    /** La sesión del usuario en una plataforma, tal como la guardó: cada plataforma decide su forma. */
    loadSession(userId: number, platform: string): Promise<string | null>;

    saveSession(userId: number, platform: string, data: string): Promise<void>;

    /** Clientes OAuth registrados por registro dinámico (RFC 7591). */
    saveClient(client: RegisteredClient): Promise<void>;

    findClient(clientId: string): Promise<RegisteredClient | null>;
}

export interface StoredUser {
    id: number;
    utnUsername: string;
    /** El institucional, el que se usa para decidir el acceso; null en usuarios de antes de guardarlo. */
    email: string | null;
}

/** Un cliente público: no tiene secreto, se autentica con PKCE. */
export interface RegisteredClient {
    clientId: string;
    clientName: string | null;
    redirectUris: string[];
}

/** `access` va en cada request al MCP; `refresh` solo sirve para pedir un `access` nuevo. */
export type TokenKind = "access" | "refresh";

export interface IssuedToken {
    userId: number;
    clientId: string | null;
    /** En segundos desde epoch; null si no vence. */
    expiresAt: number | null;
}
