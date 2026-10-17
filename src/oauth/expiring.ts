import { randomBytes } from "node:crypto";

/**
 * Valores que viven en memoria hasta que se usan o vencen: los pedidos de `/authorize` mientras el
 * usuario completa el login y los codes hasta que el cliente los canjea. Si el servidor se reinicia,
 * se pierden y el cliente vuelve a empezar el OAuth, que es lo que haría igual con un code vencido.
 */
export class Expiring<T> {
    private readonly items = new Map<string, { value: T; expiresAt: number }>();

    /** `ttlMs` en milisegundos. */
    constructor(private readonly ttlMs: number) {}

    add(value: T): string {
        this.sweep();
        const id = randomBytes(24).toString("base64url");
        this.items.set(id, { value, expiresAt: Date.now() + this.ttlMs });
        return id;
    }

    get(id: string): T | undefined {
        this.sweep();
        return this.items.get(id)?.value;
    }

    /** Lo devuelve y lo borra: un code se canjea una sola vez. */
    take(id: string): T | undefined {
        const value = this.get(id);
        this.items.delete(id);
        return value;
    }

    private sweep() {
        const now = Date.now();
        for (const [id, item] of this.items) if (item.expiresAt <= now) this.items.delete(id);
    }
}

/** Cuenta intentos por clave (la IP) en una ventana fija. */
export class RateLimiter {
    private readonly hits = new Map<string, { count: number; resetAt: number }>();

    /** `windowMs` en milisegundos. */
    constructor(
        private readonly max: number,
        private readonly windowMs: number,
    ) {}

    allow(key: string): boolean {
        const now = Date.now();
        for (const [k, hit] of this.hits) if (hit.resetAt <= now) this.hits.delete(k);
        const hit = this.hits.get(key) ?? { count: 0, resetAt: now + this.windowMs };
        hit.count++;
        this.hits.set(key, hit);
        return hit.count <= this.max;
    }
}
