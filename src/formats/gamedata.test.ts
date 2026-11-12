import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyWalk, gameArchives, gameRoots, namesFor, walkArchive } from '../testing/game-archives';

/**
 * Every MIX under a game install, every archive inside those, and every file
 * inside them run through its parser. Opt-in, since the files aren't ours to commit:
 *   npm run test:game-data   (the installed games, as npm run test:setup found or was told them)
 *   CHIMERA_GAME_DATA=/path/to/CNCDATA npx vitest run src/formats/gamedata.test.ts
 * Several installs can be given, separated by ":" (";" on Windows). As in the
 * app, names are also learned from the INIs in each install's archives. For
 * only which format each file is taken for, quickly: npm run test:formats.
 */
const roots = gameRoots();

describe.skipIf(!roots.length)('game data', () => {
    it.each(gameArchives(roots).map(({ root, path, label }) => [label, root, path]))(
        '%s',
        async (label, root, path) => {
            const walked = emptyWalk();
            /** Files refused by the format their name suggested, which nothing else read: named wrong (TD's 64 KB tables named .pal). */
            const misnamed: string[] = [];
            const names = namesFor(root);
            await walkArchive(
                basename(path),
                new Uint8Array(readFileSync(path)),
                names,
                async ({ path: where, entry, format }) => {
                    try {
                        const result = (await format.load()).parse(entry.data, { name: entry.name, names });
                        for (const w of result.warnings) walked.problems.push(`${where} (${format.id}): ${w}`);
                        // Movies decode on demand, so play each one through.
                        if (result.preview?.kind === 'video') for (let i = 0; i < result.preview.frameCount; i++) result.preview.frame(i);
                    } catch (e) {
                        if (!format.sniff(entry.data)) misnamed.push(`${entry.label}: ${e instanceof Error ? e.message : e}`);
                        else walked.problems.push(`${where} (${format.id}) threw: ${e instanceof Error ? e.message : e}`);
                    }
                },
                walked
            );
            console.log(
                `${label}: ${walked.archives} archives (${walked.encrypted} encrypted), ${walked.named}/${walked.files} named, ${JSON.stringify(walked.types)}${misnamed.length ? `; named for a format they aren't: ${misnamed.join('; ')}` : ''}`
            );
            expect(walked.problems).toEqual([]);
        },
        600_000
    );
});
