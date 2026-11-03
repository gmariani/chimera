import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Entry } from '../core/types';
import { detect } from './index';
import { parseMix } from './mix';

/**
 * Every MIX under a game install, every archive inside those, and every file
 * inside them run through its parser. Opt-in, since the files aren't ours to commit:
 *   CHIMERA_GAME_DATA=/path/to/CNCDATA npx vitest run src/formats/gamedata.test.ts
 */
const root = process.env.CHIMERA_GAME_DATA;

function mixFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return mixFiles(path);
        return /\.mix$/i.test(name) ? [path] : [];
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
    encrypted: number;
    files: number;
    named: number;
    types: Record<string, number>;
    problems: string[];
}

async function walk(name: string, data: Uint8Array, report: Report, depth = 0): Promise<void> {
    let entries: Entry[];
    try {
        const parsed = parseMix(data, { name, names: [] });
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
            await walk(path, entry.data, report, depth + 1);
            continue;
        }
        try {
            const result = (await format.load()).parse(entry.data, { name: entry.name, names: [] });
            report.problems.push(...result.warnings.map((w) => `${path} (${format.id}): ${w}`));
        } catch (e) {
            report.problems.push(`${path} (${format.id}) threw: ${e instanceof Error ? e.message : e}`);
        }
    }
}

describe.skipIf(!root)('game data', () => {
    const archives = root ? distinct(mixFiles(root)) : [];
    it.each(archives.map((p) => [p.slice(root!.length + 1), p]))('%s', async (label, path) => {
        const report: Report = { archives: 0, encrypted: 0, files: 0, named: 0, types: {}, problems: [] };
        await walk(basename(path), new Uint8Array(readFileSync(path)), report);
        console.log(`${label}: ${report.archives} archives (${report.encrypted} encrypted), ${report.named}/${report.files} named, ${JSON.stringify(report.types)}`);
        expect(report.problems).toEqual([]);
    }, 120_000);
});
