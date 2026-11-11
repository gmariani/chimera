/**
 * Where the games are, for the tests that read real game files. The files
 * aren't ours to commit, so these tests read them where they are installed and
 * skip when they can't be found.
 *
 * Each game's folder comes from, in order: its environment variable, the
 * gitignored game-data.local.json at the repo's root (`npm run test:setup`
 * writes it, asking for each path), or a few usual places. A folder only
 * counts if it holds what the game must have (Dune II: DUNE.PAK).
 *
 * This runs in Node (the tests, and the setup script without a bundler), so it
 * imports only Node's own modules.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Game {
    name: string;
    /** The environment variable that overrides the settings file. */
    env: string;
    /** What has to be directly in the folder (any of them; names compared without case). */
    marker: string[];
    /** What to ask for, in words. */
    hint: string;
    /** Places to look when nothing says where: relative to the repo, or under a Steam library's common/ folder. */
    repoGuesses: string[];
    steamGuesses: string[];
}

export const GAMES = {
    dune2: {
        name: 'Dune II',
        env: 'CHIMERA_DUNE2',
        marker: ['DUNE.PAK'],
        hint: 'the folder with DUNE.PAK, ATRE.PAK and the other PAKs',
        repoGuesses: ['samples/westwood/dune II', 'samples/westwood/Dune II'],
        steamGuesses: [],
    },
    cncRemastered: {
        name: 'C&C Remastered Collection',
        env: 'CHIMERA_CNC_REMASTERED',
        marker: ['TIBERIAN_DAWN', 'RED_ALERT'],
        hint: 'its Data/CNCDATA folder, which holds TIBERIAN_DAWN and RED_ALERT',
        repoGuesses: [],
        steamGuesses: ['CnCRemastered/Data/CNCDATA'],
    },
    tiberianSun: {
        name: 'Tiberian Sun',
        env: 'CHIMERA_TIBERIAN_SUN',
        marker: ['TIBSUN.MIX'],
        hint: 'the folder with TIBSUN.MIX',
        repoGuesses: [],
        steamGuesses: ['Command & Conquer Tiberian Sun'],
    },
    redAlert2: {
        name: 'Red Alert 2',
        env: 'CHIMERA_RED_ALERT_2',
        marker: ['RA2.MIX'],
        hint: 'the folder with RA2.MIX (and RA2MD.MIX, for Yuri’s Revenge)',
        repoGuesses: [],
        steamGuesses: ['Command & Conquer Red Alert II'],
    },
} satisfies Record<string, Game>;

export type GameId = keyof typeof GAMES;

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const SETTINGS = join(REPO, 'game-data.local.json');

/** Steam's libraries on this machine: the default one, and any others its own list names. */
function steamLibraries(): string[] {
    const roots = [join(homedir(), '.local/share/Steam'), join(homedir(), '.steam/steam')];
    const found = new Set<string>();
    for (const root of roots) {
        const list = join(root, 'steamapps/libraryfolders.vdf');
        if (!existsSync(list)) continue;
        found.add(join(root, 'steamapps/common'));
        for (const m of readFileSync(list, 'utf8').matchAll(/"path"\s+"([^"]+)"/g)) found.add(join(m[1].replace(/\\\\/g, '\\'), 'steamapps/common'));
    }
    return [...found];
}

/** Why a folder isn't the game's, or null if it is. */
export function checkFolder(id: GameId, folder: string): string | null {
    if (!existsSync(folder)) return 'There is no such folder.';
    if (!statSync(folder).isDirectory()) return 'That is a file, not a folder.';
    const names = new Set(readdirSync(folder).map((n) => n.toLowerCase()));
    const game = GAMES[id];
    return game.marker.some((m) => names.has(m.toLowerCase())) ? null : `It doesn't hold ${game.marker.join(' or ')}, so it isn't ${game.hint}.`;
}

/** What the settings file says, if there is one. */
export function readSettings(): Partial<Record<GameId, string>> {
    if (!existsSync(SETTINGS)) return {};
    try {
        return JSON.parse(readFileSync(SETTINGS, 'utf8'));
    } catch {
        return {};
    }
}

/** Where a game would be looked for when nothing says where. */
export function guesses(id: GameId): string[] {
    const game: Game = GAMES[id];
    return [...game.repoGuesses.map((g) => join(REPO, g)), ...steamLibraries().flatMap((lib) => game.steamGuesses.map((g) => join(lib, g)))];
}

/** Where a game came from, and the folder, or null when it isn't found. */
export function locate(id: GameId): { folder: string; from: 'environment' | 'settings' | 'found' } | null {
    const game = GAMES[id];
    const told = process.env[game.env];
    if (told) return checkFolder(id, resolve(told)) === null ? { folder: resolve(told), from: 'environment' } : null;
    const saved = readSettings()[id];
    if (saved) {
        const folder = isAbsolute(saved) ? saved : resolve(REPO, saved);
        return checkFolder(id, folder) === null ? { folder, from: 'settings' } : null;
    }
    const found = guesses(id).find((g) => checkFolder(id, g) === null);
    return found ? { folder: found, from: 'found' } : null;
}

/** A game's folder for a test, or null to skip it. */
export function gameDir(id: GameId): string | null {
    return locate(id)?.folder ?? null;
}

/** A file in a game's folder, matched without case (the games' files are upper case, but copies may not be). */
export function gameFile(id: GameId, name: string): string | null {
    const folder = gameDir(id);
    if (!folder) return null;
    const hit = readdirSync(folder).find((n) => n.toLowerCase() === name.toLowerCase());
    return hit ? join(folder, hit) : null;
}

/** The game's files whose names match, in order. */
export function gameFiles(id: GameId, pattern: RegExp): string[] {
    const folder = gameDir(id);
    return folder
        ? readdirSync(folder)
              .filter((n) => pattern.test(n))
              .sort()
              .map((n) => join(folder, n))
        : [];
}
