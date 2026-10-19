interface Regional {
    baseUrl: string;
    ssoHost?: string;
}

const REGIONALS: Record<string, Regional> = {
    frba: { baseUrl: "https://aulasvirtuales.frba.utn.edu.ar", ssoHost: "auth.frba.utn.edu.ar" },
    frt: { baseUrl: "https://frt.cvg.utn.edu.ar" },
};

const DEFAULT_REGIONAL = "frba";

/** `UTN_REGIONAL` no está en el registro: sin cortar acá, las credenciales irían al SSO de FRBA. */
export class UnknownRegionalError extends Error {
    name = "UnknownRegionalError";
    constructor(regional: string) {
        super(
            `UTN_REGIONAL="${regional}" no es una regional conocida. Las válidas son: ${Object.keys(REGIONALS).join(", ")}. ` +
                "Si tu campus no está en la lista, borrá UTN_REGIONAL y definí UTN_AULA_BASE_URL con la URL del aula " +
                "(y UTN_SSO_HOST si usa Keycloak).",
        );
    }
}

/** Elige el aula: la regional de `UTN_REGIONAL` si está en el registro; si no, `UTN_AULA_BASE_URL`; si no, FRBA. */
function resolve(): { baseUrl: string; ssoHost?: string } {
    const regional = (process.env.UTN_REGIONAL || "").trim().toLowerCase();
    if (regional) {
        const r = REGIONALS[regional];
        if (!r) throw new UnknownRegionalError(regional);
        return { baseUrl: r.baseUrl, ssoHost: r.ssoHost };
    }
    if (process.env.UTN_AULA_BASE_URL) {
        return {
            baseUrl: process.env.UTN_AULA_BASE_URL,
            ssoHost: process.env.UTN_SSO_HOST,
        };
    }
    const r = REGIONALS[DEFAULT_REGIONAL];
    return { baseUrl: r.baseUrl, ssoHost: r.ssoHost };
}

const resolved = resolve();
export const AULA_BASE_URL = resolved.baseUrl.replace(/\/+$/, "");
export const SSO_HOST: string | undefined = resolved.ssoHost;
