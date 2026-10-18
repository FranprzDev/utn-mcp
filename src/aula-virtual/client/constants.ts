// Registro de regionales de la UTN: cada una tiene su aula virtual (Moodle) y, si usa SSO
// Keycloak como FRBA, el host del SSO. Para agregar una regional nueva, sumá una entrada acá.
interface Regional {
    baseUrl: string;
    ssoHost?: string;
}

const REGIONALS: Record<string, Regional> = {
    frba: { baseUrl: "https://aulasvirtuales.frba.utn.edu.ar", ssoHost: "auth.frba.utn.edu.ar" },
    frt: { baseUrl: "https://frt.cvg.utn.edu.ar" },
};

const DEFAULT_REGIONAL = "frba";

// La regional se elige con UTN_REGIONAL (ej. "frt"). Si no está en el registro, se puede dar
// la URL completa con UTN_AULA_BASE_URL (y UTN_SSO_HOST si usa Keycloak).
function resolve(): { baseUrl: string; ssoHost?: string } {
    const regional = (process.env.UTN_REGIONAL || "").trim().toLowerCase();
    if (regional && REGIONALS[regional]) {
        const r = REGIONALS[regional];
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