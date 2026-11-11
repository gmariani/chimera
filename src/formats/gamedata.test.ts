import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Entry } from '../core/types';
import { detect } from './index';
import { parseMix } from './mix';
import { namesFromText } from './mix/names';
import { sniffText } from './westwood/sniff';

/**
 * Every MIX under a game install, every archive inside those, and every file
 * inside them run through its parser. Opt-in, since the files aren't ours to commit:
 *   CHIMERA_GAME_DATA=/path/to/CNCDATA npx vitest run src/formats/gamedata.test.ts
 * Several installs can be given, separated by ":" (";" on Windows). As in the
 * app, names are also learned from the INIs in each install's archives.
 */
const roots = process.env.CHIMERA_GAME_DATA?.split(delimiter).filter(Boolean) ?? [];

function mixFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return mixFiles(path);
        return /\.(mix|mmx|yro)$/i.test(name) ? [path] : [];
    });
}

/** The same archive ships on several CDs; check each distinct one once. */
function distinct(paths: string[]): string[] {
    const seen = new Map<string, string>();
    for (const path of paths) {
        const key = `${basename(path).toLowerCase()}:${statSync(path).size}`;
        if (!seen.has(key)) seen.set(key, path);
    }
    return [...seen.values()];
}

interface Report {
    archives: number;
    /** Files refused by the format their name suggested, which nothing else read: named wrong (TD's 64 KB tables named .pal). */
    misnamed: string[];
    encrypted: number;
    files: number;
    named: number;
    types: Record<string, number>;
    problems: string[];
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

async function walk(name: string, data: Uint8Array, names: string[], report: Report, depth = 0): Promise<void> {
    let entries: Entry[];
    try {
        const parsed = parseMix(data, { name, names });
        report.archives++;
        if (parsed.overlays?.length) report.encrypted++;
        report.problems.push(...parsed.warnings.map((w) => `${name}: ${w}`));
        entries = parsed.entries ?? [];
    } catch (e) {
        report.problems.push(`${name}: couldn't read: ${e instanceof Error ? e.message : e}`);
        return;
    }
    for (const entry of entries) {
        const path = `${name} › ${entry.label}`;
        const format = detect(entry.data, entry.name);
        report.files++;
        if (entry.name) report.named++;
        report.types[format.id] = (report.types[format.id] ?? 0) + 1;
        if (format.id === 'mix' && depth < 4) {
            await walk(path, entry.data, names, report, depth + 1);
            continue;
        }
        try {
            const result = (await format.load()).parse(entry.data, { name: entry.name, names });
            report.problems.push(...result.warnings.map((w) => `${path} (${format.id}): ${w}`));
            // Movies decode on demand, so play each one through.
            if (result.preview?.kind === 'video') for (let i = 0; i < result.preview.frameCount; i++) result.preview.frame(i);
        } catch (e) {
            if (!format.sniff(entry.data)) report.misnamed.push(`${entry.label}: ${e instanceof Error ? e.message : e}`);
            else report.problems.push(`${path} (${format.id}) threw: ${e instanceof Error ? e.message : e}`);
        }
    }
}

describe.skipIf(!roots.length)('game data', () => {
    const archives = roots.flatMap((root) => distinct(mixFiles(root)).map((path) => ({ root, path })));
    const learned = new Map<string, string[]>();
    const namesFor = (root: string) => {
        if (!learned.has(root)) learned.set(root, namesFromText(distinct(mixFiles(root)).flatMap((p) => texts(new Uint8Array(readFileSync(p)), []))));
        return learned.get(root)!;
    };
    it.each(archives.map(({ root, path }) => [join(basename(root), path.slice(root.length + 1)), root, path]))(
        '%s',
        async (label, root, path) => {
            const report: Report = { archives: 0, encrypted: 0, files: 0, named: 0, types: {}, misnamed: [], problems: [] };
            await walk(basename(path), new Uint8Array(readFileSync(path)), namesFor(root), report);
            console.log(
                `${label}: ${report.archives} archives (${report.encrypted} encrypted), ${report.named}/${report.files} named, ${JSON.stringify(report.types)}${report.misnamed.length ? `; named for a format they aren't: ${report.misnamed.join('; ')}` : ''}`
            );
            expect(report.problems).toEqual([]);
        },
        600_000
    );
});
