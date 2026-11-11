/**
 * Writes the generated samples (src/testing/samples.ts) to samples/generated/,
 * with a README saying what each is, and removes any it no longer makes.
 * Run with `npm run samples` after changing the generator; the tests check the
 * committed files still match it.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO } from '../src/testing/game-data.ts';
import { samples } from '../src/testing/samples.ts';

const dir = join(REPO, 'samples/generated');
mkdirSync(dir, { recursive: true });
const made = samples();
const names = new Set([...made.map((s) => s.name), 'README.md']);
for (const old of readdirSync(dir)) if (!names.has(old)) rmSync(join(dir, old));
for (const s of made) writeFileSync(join(dir, s.name), s.data);

const rows = made.map((s) => `| \`${s.name}\` | ${s.about} | ${s.data.length.toLocaleString('en-US')} bytes |`);
writeFileSync(
    join(dir, 'README.md'),
    `# Generated samples

Small, valid files of formats Chimera reads, made from scratch by \`src/testing/samples.ts\` (no game files, so they're ours to commit). Each reads as its format with nothing to warn about; \`src/testing/samples.test.ts\` checks that, and that these files still match what the generator makes.

Don't edit them by hand: change the generator and run \`npm run samples\`.

The pictures are one 320 × 200 test card in 16 colors (bands, a checkerboard, a diagonal, a frame), so every compression can be checked against the same thing.

| File | What it is | Size |
| --- | --- | --- |
${rows.join('\n')}
`
);
console.log(`Wrote ${made.length} samples to ${dir}.`);
