import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Field, Parsed } from '../../core/types';
import { gameFile } from '../../testing/game-data';
import { adlMusic } from '../../testing/samples';
import { detect } from '../index';
import { inspect } from '../inspect';
import parser from './adl';
import pak from './pak';

const parse = (data: Uint8Array, name = 'MUSIC.ADL') => parser.parse(data, { name, names: [] }) as Parsed;
const summary = (r: Parsed, key: string) => r.summary.find(([k]) => k === key)?.[1];
const text = (r: Parsed) => {
    const p = r.preview?.kind === 'stack' ? r.preview.items[0].preview : r.preview;
    return p?.kind === 'text' ? p.text : '';
};
const find = (fields: Field[], name: string) => fields.find((f) => f.name === name);
/** Where the sample's data starts (version 3), and so its programs: 9, 14 and 12 bytes. */
const DATA = 1120;
const le16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];

describe('Westwood AdLib music (ADL)', () => {
    it('lists the tracks, and reads each program’s commands and each instrument', () => {
        const data = adlMusic();
        expect(detect(data, 'MUSIC.ADL').id).toBe('adl');
        expect(detect(data, null).id).toBe('adl');
        const r = parse(data);
        expect(r.warnings).toEqual([]);
        expect(r.summary).toEqual([
            ['Version', '2 or 3 (Eye of the Beholder II, Kyrandia, Dune II)'],
            ['Tracks', '1 track'],
            ['Programs', '3, 16 commands'],
            ['Instruments', '2 (2 used)'],
            ['Calls', 'None, so versions 2 and 3 read it alike'],
        ]);
        expect(text(r)).toBe('Track 0: program 0, the conductor, starting 1 (voice 0), 2 (voice 1)');
        // Not one of Dune II's, so the tracks that start the conductor play, as music does.
        const played = r.preview?.kind === 'stack' ? r.preview.items.slice(1) : [];
        expect(played.map((i) => i.title)).toEqual(['Track 0']);
        const track = played[0].preview;
        expect(track.kind === 'music' && [track.notes.length > 0, track.audio?.sampleRate, track.note]).toEqual([true, 22050, 'Played as the game plays it: Westwood’s player, on an emulated AdLib.']);
        const loop = find(r.fields, 'Program 1')!.children!;
        expect(loop.map((c) => c.name)).toEqual(['Voice', 'Priority', 'Instrument', 'Set the repeat count', 'Note', 'Note', 'Repeat: jump back while the count lasts', 'Stop']);
        expect(loop[4].value).toBe('0x45: octave 4, note 5, for 16');
        // The repeat lands on its count, 0xBB, as Westwood's do: read as a command, it does nothing.
        expect(loop[6].value).toBe(`to ${(DATA + 9 + 5).toLocaleString('en-US')}, while the count lasts`);
        expect(loop[3].note).toMatch(/0xBB.*"Nothing"/);
        expect(find(r.fields, 'Instrument 1')!.children![2]).toMatchObject({ name: 'Feedback and connection', value: '0x01' });
        // Every byte once.
        expect(r.fields.reduce((n, f) => n + f.length, 0)).toBe(data.length);
    });

    it('tells the versions apart by their tables', () => {
        // Version 1: data from 720, and jumps counted from 191 before the end of the track table (here, to the command after it).
        const v1 = adlMusic({ version: 1, change: (p) => p[2].splice(7, 2, ...le16(720 + 9 + 14 + 9 - 120 + 191)) });
        const r1 = parse(v1);
        expect(r1.warnings).toEqual([]);
        expect(summary(r1, 'Version')).toBe('1 (Eye of the Beholder)');
        // Version 4: 250 track words, 500 programs and instruments.
        const r4 = parse(adlMusic({ version: 4 }));
        expect(r4.warnings).toEqual([]);
        expect(summary(r4, 'Version')).toBe('4 (Kyrandia 2 and 3, Lands of Lore)');
        expect(find(r4.fields, 'Program 0')?.offset).toBe(2500);
    });

    it('says what doesn’t fit', () => {
        // A repeat landing on a count that isn't 0xBB: from the second time round, the count is read as a note.
        expect(parse(adlMusic({ count: 4 })).warnings).toEqual([
            `The repeat at ${(DATA + 9 + 10).toLocaleString('en-US')} jumps back to its count's own byte (4), not the command after it: from the second time round the player reads that byte as a note, and what follows out of step.`,
        ]);
        // A command the player doesn't have (0x94, one of the gaps in its table), for program 2's stop.
        expect(parse(adlMusic({ change: (p) => (p[2][11] = 0x94) })).warnings).toEqual([
            `The command at ${(DATA + 9 + 14 + 11).toLocaleString('en-US')} (0x94) isn’t one the player has: it stops the voice there.`,
        ]);
        expect(parse(adlMusic({ change: (p) => (p[2][3] = 5) })).warnings).toEqual([
            'Commands use instrument 5, which isn’t there: Dune II’s player would set up the voice from the bytes the empty entry points to.',
        ]);
        expect(parse(adlMusic({ change: (p) => (p[0][5] = 9) })).warnings.join()).toMatch(/^Commands start or wait for program 9, which isn’t there/);
        expect(parse(adlMusic({ change: (p) => (p[1][0] = 12) })).warnings).toEqual(['Program 1 is for voice 12; there are 10 (0 to 8, and 9, the conductor): the player ignores it.']);
        expect(parse(adlMusic({ change: (p) => p[2].splice(7, 2, ...le16(-5000 & 0xffff)) })).warnings.join()).toMatch(/^The jump at 1,149 goes to -3,848, outside the music data/);
        // The last program without its stop, the file cut off after it (before the instruments).
        const open = adlMusic({ change: (p) => p[2].pop() });
        expect(parse(open.subarray(0, DATA + 9 + 14 + 11)).warnings.join()).toMatch(/1 program runs off the end of the file without a stop/);
        // An instrument said to be in the middle of program 0's commands.
        const into = adlMusic();
        into.set(le16(DATA - 120 + 2), 120 + 250 * 2);
        expect(parse(into).warnings.join()).toMatch(/of the data are read two ways/);
        // A program said to be inside the tables, and one past the end.
        const inside = adlMusic();
        inside.set(le16(5), 120 + 2 * 2);
        expect(parse(inside).warnings).toContain('Program 2 is said to be at 125, inside the tables: the player would read them as one.');
    });

    it('refuses what can’t be one', () => {
        expect(() => parse(new Uint8Array(700))).toThrow(/the smallest version's tables alone take 720/);
        // Version 2 or 3's offsets, but too short for its tables.
        expect(() => parse(adlMusic().subarray(0, 1000))).toThrow(/its version's tables alone take 1,120/);
    });

    // Dune II's own, in SOUND.PAK, from wherever it's installed (npm run test:setup).
    const PAK = gameFile('dune2', 'SOUND.PAK') ?? '';
    it.skipIf(!PAK)('reads Dune II’s 21, the game’s music where OpenDUNE says it is', { timeout: 60_000 }, async () => {
        const files = pak.parse(new Uint8Array(readFileSync(PAK)), { name: 'SOUND.PAK', names: [] }).entries!.filter((e) => e.label.endsWith('.ADL'));
        expect(files).toHaveLength(21);
        // Known faults of the shipped files: DUNE0's three short loops land on their counts' bytes, and one of its programs runs
        // into a byte the player stops at; DUNE7, DUNE16 and DUNE17 use an instrument they don't have.
        const known: Record<string, RegExp[]> = {
            'DUNE0.ADL': [/^The repeat at 1,837 /, /^The repeat at 1,811 /, /^The repeat at 1,787 /, /^The command at 1,504 \(0xDB\)/],
            'DUNE7.ADL': [/^Commands use instrument 62,/],
            'DUNE16.ADL': [/^Commands use instrument 62,/],
            'DUNE17.ADL': [/^Commands use instrument 181,/],
        };
        for (const e of files) {
            expect(detect(e.data, null).id, e.label).toBe('adl');
            const r = await inspect(e.data, { name: e.label, names: [] });
            expect(r.format.id, e.label).toBe('adl');
            expect(
                r.checks.filter((c) => c.level !== 'info'),
                e.label
            ).toEqual([]);
            const expected = known[e.label] ?? [];
            expect(r.parsed.warnings, e.label).toHaveLength(expected.length);
            expected.forEach((pattern, i) => expect(r.parsed.warnings[i], e.label).toMatch(pattern));
            expect(summary(r.parsed, 'Version'), e.label).toBe('2 or 3 (Eye of the Beholder II, Kyrandia, Dune II)');
            // OpenDUNE's music table names tracks the game plays as music: each that's in the file starts the conductor.
            for (const line of text(r.parsed)
                .split('\n')
                .filter((l) => /^Track \d+ \(/.test(l)))
                expect(line, `${e.label}: ${line}`).toMatch(/: program \d+, the conductor, starting /);
        }
        const dune1 = parse(files.find((e) => e.label === 'DUNE1.ADL')!.data, 'DUNE1.ADL');
        // The music OpenDUNE's table names, played: all but track 8, which the file lacks.
        const titles = (r: Parsed) => (r.preview?.kind === 'stack' ? r.preview.items.slice(1).map((i) => i.title) : []);
        expect(titles(dune1)).toEqual([
            'Track 2: listed, but never played',
            'Track 3: an Ordos defeat',
            'Track 4: a Harkonnen defeat',
            'Track 5: an Atreides defeat',
            'Track 6: in the field, one of nine at random',
        ]);
        // DUNE17's music is the only music to use an instrument its file lacks (DUNE7's and DUNE16's 62 is a sound effect's).
        const dune17 = parse(files.find((e) => e.label === 'DUNE17.ADL')!.data, 'DUNE17.ADL');
        const music17 = dune17.preview?.kind === 'stack' ? dune17.preview.items[1].preview : null;
        expect(music17?.kind === 'music' && music17.note).toContain('It uses instrument 181, which the file lacks: set up, as the game does, from the bytes its empty entry points to.');
        expect(text(dune1)).toContain(
            'Track 2 (listed, but never played): program 197, the conductor, starting 198 (voice 0), 199 (voice 1), 200 (voice 2), 201 (voice 3), 202 (voice 4), 203 (voice 5)'
        );
    });
});
