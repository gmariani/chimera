import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, delimiter, join } from 'node:path';
import type { Entry, FormatDescriptor } from '../core/types';
import { detect } from '../formats/index';
import { parseMix } from '../formats/mix';
import { namesFromText } from '../formats/mix/names';
import { sniffText } from '../formats/westwood/sniff';
import { gameDir } from './game-data';

/**
 * Every MIX archive of the installed games (C&C Remastered, Tiberian Sun, Red
 * Alert 2), and every file inside them: what the game-data test reads in
 * full (gamedata.test.ts) and the format counts compare (format-counts.test.ts).
 * As in the app, names are also learned from the INIs in each install's archives.
 */

/** The folders to read: from CHIMERA_GAME_DATA, "installed" for the games the other tests find (npm run test:setup), or folders. */
export function gameRoots(): string[] {
    const told = process.env.CHIMERA_GAME_DATA;
    return told === 'installed' ? (['cncRemastered', 'tiberianSun', 'redAlert2'] as const).map(gameDir).filter((d): d is string => d !== null) : (told?.split(delimiter).filter(Boolean) ?? []);
}

function mixFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return mixFiles(path);
        return /\.(mix|mmx|yro)$/i.test(name) ? [path] : [];
    });
}

/** The same archive ships on several CDs; each distinct one is read once. */
function distinct(paths: string[]): string[] {
    const seen = new Map<string, string>();
    for (const path of paths) {
        const key = `${basename(path).toLowerCase()}:${statSync(path).size}`;
        if (!seen.has(key)) seen.set(key, path);
    }
    return [...seen.values()];
}

/** Each distinct archive under the roots, with the root it's under and a label to show it by. */
export function gameArchives(roots: string[]): { root: string; path: string; label: string }[] {
    return roots.flatMap((root) => distinct(mixFiles(root)).map((path) => ({ root, path, label: join(basename(root), path.slice(root.length + 1)) })));
}

/** The text in every archive under a root, nested ones too, to learn names from. */
function texts(data: Uint8Array, out: string[], depth = 0): string[] {
    let entries: Entry[] = [];
    try {
        entries = parseMix(data, { name: null, names: [] }).entries ?? [];
    } catch {
        return out;
    }
    for (const e of entries) {
        if (detect(e.data, e.name).id === 'mix' && depth < 4) texts(e.data, out, depth + 1);
        else if (sniffText(e.data)) out.push(new TextDecoder('latin1').decode(e.data));
    }
    return out;
}

const learned = new Map<string, string[]>();
/** The names learned from a root's INIs, once a root. */
export function namesFor(root: string): string[] {
    if (!learned.has(root)) learned.set(root, namesFromText(distinct(mixFiles(root)).flatMap((p) => texts(new Uint8Array(readFileSync(p)), []))));
    return learned.get(root)!;
}

export interface Walked {
    archives: number;
    encrypted: number;
    files: number;
    named: number;
    /** How many files were detected as each format. */
    types: Record<string, number>;
    problems: string[];
}

/** One file in an archive, as detected: what the walk hands each to look at (archives inside are walked into instead). */
export type Visit = (file: { path: string; entry: Entry; format: FormatDescriptor }) => Promise<void> | void;

/** An archive and the archives inside it (4 deep), detecting each file; `visit` is shown each that isn't an archive. */
export async function walkArchive(name: string, data: Uint8Array, names: string[], visit: Visit, walked: Walked, depth = 0): Promise<void> {
    let entries: Entry[];
    try {
        const parsed = parseMix(data, { name, names });
        walked.archives++;
        if (parsed.overlays?.length) walked.encrypted++;
        for (const w of parsed.warnings) walked.problems.push(`${name}: ${w}`);
        entries = parsed.entries ?? [];
    } catch (e) {
        walked.problems.push(`${name}: couldn't read: ${e instanceof Error ? e.message : e}`);
        return;
    }
    for (const entry of entries) {
        const path = `${name} › ${entry.label}`;
        const format = detect(entry.data, entry.name);
        walked.files++;
        if (entry.name) walked.named++;
        walked.types[format.id] = (walked.types[format.id] ?? 0) + 1;
        if (format.id === 'mix' && depth < 4) await walkArchive(path, entry.data, names, visit, walked, depth + 1);
        else await visit({ path, entry, format });
    }
}

export const emptyWalk = (): Walked => ({ archives: 0, encrypted: 0, files: 0, named: 0, types: {}, problems: [] });
