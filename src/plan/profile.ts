import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { profileFile } from "../shared/paths.js";

export interface Profile {
    carrera?: string;
    plan?: string;
}

const FIELD = /^\s*[-*]\s*(carrera|plan)\s*:\s*(.+?)\s*$/i;

export function parseProfile(markdown: string): Profile {
    const profile: Profile = {};
    for (const line of markdown.split("\n")) {
        const match = FIELD.exec(line);
        if (!match) continue;
        const key = match[1].toLowerCase() as keyof Profile;
        profile[key] ??= match[2];
    }
    return profile;
}

export function renderProfile(profile: Required<Profile>): string {
    return [
        "# Perfil de UTN-MCP",
        "",
        "Lo usan las tools de plan de estudios para no preguntarte la carrera y el plan cada vez. Podés editarlo a mano.",
        "",
        `- carrera: ${profile.carrera}`,
        `- plan: ${profile.plan}`,
        "",
    ].join("\n");
}

export async function readProfile(): Promise<Profile> {
    try {
        return parseProfile(await readFile(profileFile(), "utf8"));
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
        throw e;
    }
}

export async function writeProfile(profile: Required<Profile>): Promise<void> {
    const file = profileFile();
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, renderProfile(profile), "utf8");
    await rename(tmp, file);
}
