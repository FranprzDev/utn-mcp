import { existsSync } from "node:fs";

// Se evalúa antes que el resto de los módulos: así las variables del `.env` (incluida
// UTN_AULA_BASE_URL) están definidas cuando se leen las constantes al importar.
if (existsSync(".env")) process.loadEnvFile(".env");
