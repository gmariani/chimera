import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyWalk, gameArchives, gameRoots, namesFor, walkArchive } from '../testing/game-archives';
import { REPO } from '../testing/game-data';

/**
 * How many files of the installed games each format takes, archive by
 * archive, against the counts saved before: a sniffer that starts claiming
 * other files fails silently (they just open as the wrong thing), and this
 * is how it shows. Only detection runs, not the readers, so it's quick; the
 * game-data test (gamedata.test.ts) reads every file in full.
 *
 *   npm run test:formats:save   counts now become the baseline (before a change, or to accept one)
 *   npm run test:formats        counts now against the baseline: any difference fails, listed
 *
 * The baseline is format-counts.local.json, gitignored: it's of the games installed here.
 */

const BASELINE = join(REPO, 'format-counts.local.json');
const roots = gameRoots();
type Counts = Record<string, Record<string, number>>;

describe.skipIf(!roots.length)('format counts', () => {
    it('match the saved baseline', { timeout: 1_800_000 }, async () => {
        const counts: Counts = {};
        for (const { root, path, label } of gameArchives(roots)) {
            const walked = emptyWalk();
            await walkArchive(basename(path), new Uint8Array(readFileSync(path)), namesFor(root), () => {}, walked);
            counts[label] = Object.fromEntries(Object.entries(walked.types).sort(([a], [b]) => a.localeCompare(b)));
        }
        const files = Object.values(counts).reduce((n, c) => n + Object.values(c).reduce((m, v) => m + v, 0), 0);

        if (process.env.CHIMERA_FORMATS_SAVE || !existsSync(BASELINE)) {
            writeFileSync(BASELINE, `${JSON.stringify(counts, null, 1)}\n`);
            console.log(`Saved the counts of ${files.toLocaleString('en-US')} files in ${Object.keys(counts).length} archives as the baseline (${BASELINE}).`);
            return;
        }

        // Archive by archive, each format whose count moved: "archive: format before → after".
        const before = JSON.parse(readFileSync(BASELINE, 'utf8')) as Counts;
        const changes: string[] = [];
        for (const label of new Set([...Object.keys(before), ...Object.keys(counts)])) {
            const was = before[label];
            const now = counts[label];
            if (!was) changes.push(`${label}: new since the baseline`);
            else if (!now) changes.push(`${label}: gone since the baseline`);
            else
                for (const format of new Set([...Object.keys(was), ...Object.keys(now)]))
                    if ((was[format] ?? 0) !== (now[format] ?? 0)) changes.push(`${label}: ${format} ${was[format] ?? 0} → ${now[format] ?? 0}`);
        }
        console.log(
            changes.length
                ? `${changes.length} count${changes.length === 1 ? ' differs' : 's differ'} from the baseline (accept them with npm run test:formats:save):\n${changes.join('\n')}`
                : `The same as the baseline: ${files.toLocaleString('en-US')} files in ${Object.keys(counts).length} archives.`
        );
        expect(changes).toEqual([]);
    });
});
