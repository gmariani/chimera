import { bytesLabel, field } from '../../core/bytes';
import type { Field, FormatParser } from '../../core/types';
import { ADL_REACH, adlLayout } from './adl-layout';

/**
 * Westwood's AdLib music (.adl): the music and sound effects of Eye of the
 * Beholder, Dune II, Kyrandia and Lands of Lore for the AdLib card's FM chip
 * (the Yamaha OPL2). Not recorded sound: a program for each of the chip's
 * nine voices, run by Westwood's player 72 times a second.
 *
 * After the tables (see adl-layout.ts) come the programs and instruments:
 *
 * - A program starts with the voice it plays on (0 to 8; 9 is the conductor,
 *   which starts the others and keeps the beat) and its priority (a program
 *   only takes a voice from one of lower priority). Then its commands: a
 *   byte below 0x80 is a note (octave in the high half, note in the low)
 *   followed by how long it lasts; a byte from 0x80 up is a command, 0x80
 *   less than its number, followed by its values. Jumps and repeats count
 *   from the byte after them (version 1's jumps, and versions 1 and 2's
 *   subroutine calls, from 191 bytes before the end of the track table).
 * - An instrument is 11 bytes for the chip's registers: each operator's
 *   character, how they're joined, their waveforms, levels, attack and decay,
 *   sustain and release.
 *
 * A track is a program the game starts by number: the music, and in the
 * games that play them here, sound effects. This follows ScummVM's player,
 * where the commands are named (engines/kyra/sound/drivers/adlib.cpp), and
 * AdPlug's loader (src/adl.cpp). How many values each command takes, and
 * where jumps and repeats land, were checked against Dune II's own player,
 * ALFX.DRV. It doesn't play the music: that needs the chip.
 */

/** Each command, by its number (the byte less 0x80): what it does and how many values follow (ScummVM's _parserOpcodeTable). */
const COMMANDS: [string, number][] = [
    ['Set the repeat count', 1],
    ['Repeat: jump back while the count lasts', 2],
    ['Start a program', 1],
    ['Note spacing', 1],
    ['Jump', 2],
    ['Call a subroutine', 2],
    ['Return from the subroutine', 0],
    ['Base octave', 1],
    ['Stop', 0],
    ['Rest', 1],
    ['Write a chip register', 2],
    ['Note and length', 2],
    ['Base note', 1],
    ['Secondary effect', 5],
    ['Stop another voice', 1],
    ['Wait for a program to end', 1],
    ['Instrument', 1],
    ['Slide', 3],
    ['End the slide', 0],
    ['Base frequency', 1],
    ['', 0],
    ['Vibrato', 4],
    ['', 0],
    ['', 0],
    ['', 0],
    ['', 0],
    ['Priority', 1],
    ['', 0],
    ['Beat', 1],
    ['Wait for the next beat', 1],
    ['Level 1', 1],
    ['', 0],
    ['Length', 1],
    ['Play the note', 1],
    ['', 0],
    ['', 0],
    ['Fractional note spacing', 1],
    ['', 0],
    ['Tempo', 1],
    ['End the secondary effect', 0],
    ['', 0],
    ['Voice tempo', 1],
    ['', 0],
    ['Level 3', 1],
    ['Level 2 of a voice', 2],
    ['Change level 2 of a voice', 2],
    ['Tremolo depth', 1],
    ['Vibrato depth', 1],
    ['Change level 1', 1],
    ['', 0],
    ['', 0],
    ['Clear a voice', 1],
    ['', 0],
    ['Change the note at random', 2],
    ['End the vibrato', 0],
    ['', 0],
    ['', 0],
    ['Pitch bend', 1],
    ['Back to the overall tempo', 0],
    ['Nothing', 0],
    ['Randomness of lengths', 1],
    ['Change the voice tempo', 1],
    ['', 0],
    ['Unnamed command 63', 2],
    ['Nothing', 0],
    ['Set up the drums', 9],
    ['Play the drums', 1],
    ['End the drums', 0],
    ['Drum level 2', 2],
    ['Change drum level 1', 2],
    ['Drum level 1', 2],
    ['Signal the game', 1],
    ['Tempo reset', 1],
    ['Unnamed command 73', 2],
    ['', 0],
];
/** Numbers past the table are taken as its last, a stop (the player clips them). */
const LAST = COMMANDS.length - 1;
const STOP = 8;
const REPEAT = 1;
const START_PROGRAM = 2;
const JUMP = 4;
const CALL = 5;
const RETURN = 6;
const WAIT_FOR_PROGRAM = 15;
const INSTRUMENT = 16;
const DRUMS = 65;
const INSTRUMENT_SIZE = 11;
/** The player's own offset for version 1's jumps (and 1 and 2's calls): they count from 191 bytes before the end of the track table. */
const ABSOLUTE_BIAS = 191;

/** The game's music, by file and track (OpenDUNE's g_table_musics, src/table/sound.c). */
const DUNE2_MUSIC: Record<string, number[]> = {
    DUNE0: [2, 3, 4, 5],
    DUNE1: [2, 3, 4, 5, 6, 8],
    DUNE2: [6],
    DUNE3: [6],
    DUNE4: [6],
    DUNE5: [6],
    DUNE6: [6],
    DUNE7: [2, 3, 4, 6],
    DUNE8: [2, 3],
    DUNE9: [4, 5],
    DUNE10: [7],
    DUNE11: [7],
    DUNE12: [7],
    DUNE13: [7],
    DUNE14: [7],
    DUNE15: [7],
    DUNE16: [7, 8],
    DUNE17: [4],
    DUNE18: [6],
    DUNE19: [2, 3, 4],
    DUNE20: [2],
};

const INSTRUMENT_BYTES: [string, string][] = [
    ['Modulator: tremolo, vibrato, sustain, key scaling, multiple', 'Chip register 0x20.'],
    ['Carrier: tremolo, vibrato, sustain, key scaling, multiple', 'Chip register 0x23.'],
    ['Feedback and connection', 'Chip register 0xC0. Bit 0 set: both operators sound; clear: the modulator shapes the carrier.'],
    ['Modulator waveform', 'Chip register 0xE0.'],
    ['Carrier waveform', 'Chip register 0xE3.'],
    ['Modulator level', 'Chip register 0x40, before the player sets the volume.'],
    ['Carrier level', 'Chip register 0x43, before the player sets the volume.'],
    ['Modulator attack and decay', 'Chip register 0x60.'],
    ['Carrier attack and decay', 'Chip register 0x63.'],
    ['Modulator sustain and release', 'Chip register 0x80.'],
    ['Carrier sustain and release', 'Chip register 0x83.'],
];

interface Command {
    at: number;
    length: number;
    name: string;
    value: string;
    /** The program it starts, for "Start a program". */
    starts?: number;
    /** Whether the voice stops or goes elsewhere after it. */
    ends?: boolean;
    /** Read only out of step, after a repeat lands on its count's byte. */
    stray?: boolean;
}

const hex2 = (v: number) => `0x${v.toString(16).toUpperCase().padStart(2, '0')}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

const parser: FormatParser = {
    parse(data, context) {
        const layout = adlLayout(data);
        if (typeof layout === 'string') throw new Error(`This isn't Westwood AdLib music. ${layout}`);
        const { version, base, trackBytes, tracks, programs, instruments, dataStart } = layout;
        const word = (i: number) => data[i] | (data[i + 1] << 8);
        const signed = (i: number) => (word(i) << 16) >> 16;
        const warnings: string[] = [];
        // The player can't read past 64 KB of data (see ADL_REACH): anything after that is past the music's end.
        const reach = Math.min(data.length, base + ADL_REACH);
        const inData = (at: number) => at >= dataStart && at < reach;

        // The tables: each offset is in the data, or it's nothing the player can use.
        const programAt = (n: number) => (n < programs.length ? programs[n] : null);
        const instrumentAt = (n: number) => (n < instruments.length ? instruments[n] : null);
        const checkOffsets = (list: (number | null)[], what: string, size: number) =>
            list.forEach((at, n) => {
                if (at === null) return;
                if (at < dataStart) warnings.push(`${what} ${n} is said to be at ${at.toLocaleString('en-US')}, inside the tables: the player would read them as one.`);
                else if (at + size > reach) warnings.push(`${what} ${n} is said to be at ${at.toLocaleString('en-US')}, which runs past the end of what the player can reach.`);
            });
        checkOffsets(programs, 'Program', 2);
        checkOffsets(instruments, 'Instrument', INSTRUMENT_SIZE);
        // Westwood's own files have tracks for programs they don't hold (Dune II's DUNE3, DUNE9 and DUNE12 start program 197
        // from tracks 71 to 73, and have none), so these are listed, not warned about.
        const missingTracks = tracks.flatMap((p, t) => (p !== null && programAt(p) === null ? [t] : []));

        // The programs' commands, from where each starts and wherever a jump, repeat or call goes. Each byte is read at most once.
        const calls: number[] = [];
        const walk = (callsRelative: boolean) => {
            const commands = new Map<number, Command>();
            /** Where to read from, and whether it's out of step with the commands (see the repeats, below). */
            const queue: { at: number; stray: boolean }[] = [];
            const missingPrograms = new Set<number>();
            const missingInstruments = new Set<number>();
            const usedInstruments = new Set<number>();
            const startedPrograms = new Set<number>();
            const badTargets: string[] = [];
            const strayRepeats: { from: number; to: number }[] = [];
            const runaways: number[] = [];
            const unknown: number[] = [];
            programs.forEach((at) => {
                if (at !== null && inData(at)) queue.push({ at: at + 2, stray: false });
            });
            const target = (from: number, next: number, kind: string, relative: boolean, stray: boolean) => {
                const to = relative ? next + signed(from + 1) : base + word(from + 1) - ABSOLUTE_BIAS;
                if (!inData(to)) badTargets.push(`The ${kind} at ${from.toLocaleString('en-US')} goes to ${to.toLocaleString('en-US')}, outside the music data.`);
                else queue.push({ at: to, stray });
                return to;
            };
            while (queue.length) {
                const item = queue.pop()!;
                let at = item.at;
                const stray = item.stray;
                for (;;) {
                    if (commands.has(at)) break;
                    if (at >= reach) {
                        if (!stray) runaways.push(at);
                        break;
                    }
                    const op = data[at];
                    if (op < 0x80) {
                        if (at + 2 > reach) {
                            if (!stray) runaways.push(at);
                            break;
                        }
                        commands.set(at, { at, length: 2, name: 'Note', value: `${hex2(op)}: octave ${op >> 4}, note ${op & 15}, for ${data[at + 1]}`, stray });
                        at += 2;
                        continue;
                    }
                    const n = Math.min(op & 0x7f, LAST);
                    const [name, count] = COMMANDS[n];
                    const next = at + 1 + count;
                    if (next > reach) {
                        if (!stray) runaways.push(at);
                        break;
                    }
                    const values = Array.from(data.subarray(at + 1, next));
                    let value = values.join(', ');
                    let ends = false;
                    if (!name) {
                        if (!stray) unknown.push(at);
                        commands.set(at, { at, length: 1, name: `Command ${op & 0x7f}`, value: 'Not one the player has: it stops the voice', stray });
                        break;
                    }
                    if (n === STOP || n === RETURN) ends = true;
                    else if (n === JUMP) {
                        value = `to ${target(at, next, 'jump', version !== 1, stray).toLocaleString('en-US')}`;
                        ends = true;
                    } else if (n === REPEAT) {
                        // Westwood's tools have a repeat jump back to the count's own byte, not the command after it: Dune II's player
                        // (ALFX.DRV) lands there, as ScummVM's and AdPlug's do. The tools set long loops' counts to 0xBB, which as a
                        // command is "Nothing", so the loop runs as written; any other count is read as a note or command, out of step.
                        const to = next + signed(at + 1);
                        const onCount = data[to - 1] === 0x80 && to - 1 >= dataStart;
                        if (onCount && data[to] !== 0xbb && !stray) strayRepeats.push({ from: at, to });
                        value = `to ${target(at, next, 'repeat', true, stray || (onCount && data[to] !== 0xbb)).toLocaleString('en-US')}, while the count lasts`;
                    } else if (n === CALL) {
                        calls.push(at);
                        value = `to ${target(at, next, 'call', callsRelative, stray).toLocaleString('en-US')}`;
                    } else if (n === START_PROGRAM || n === WAIT_FOR_PROGRAM) {
                        const p = values[0];
                        if (n === START_PROGRAM && p === 0xff) value = 'none';
                        else {
                            value = `program ${p}`;
                            if (programAt(p) === null) missingPrograms.add(p);
                            else startedPrograms.add(p);
                        }
                    } else if (n === INSTRUMENT || n === DRUMS) {
                        const used = n === INSTRUMENT ? [values[0]] : values.slice(0, 3);
                        for (const i of used) (instrumentAt(i) === null ? missingInstruments : usedInstruments).add(i);
                        value = n === INSTRUMENT ? `instrument ${values[0]}` : `instruments ${used.join(', ')}; ${values.slice(3).join(', ')}`;
                    }
                    const starts = n === START_PROGRAM && values[0] !== 0xff ? values[0] : undefined;
                    commands.set(at, { at, length: next - at, name, value, starts, ends, stray });
                    if (ends) break;
                    at = next;
                }
            }
            return { commands, missingPrograms, missingInstruments, usedInstruments, startedPrograms, badTargets, strayRepeats, runaways, unknown };
        };
        // Versions 2 and 3 differ only in how a call counts (from 191 before the data in 2, from after itself in 3), and nothing
        // says which: take the one whose calls all land on commands.
        let walked = walk(version === 4);
        let callsRelative = version === 4;
        if (version === 2 && calls.length) {
            calls.length = 0;
            const relative = walk(true);
            // On a tie, version 3: Kyrandia's and Dune II's.
            if (relative.badTargets.length <= walked.badTargets.length) {
                walked = relative;
                callsRelative = true;
            }
        }
        const { commands, missingPrograms, missingInstruments, usedInstruments, startedPrograms, badTargets, strayRepeats, runaways, unknown } = walked;
        for (const b of badTargets) warnings.push(b);
        for (const r of strayRepeats)
            warnings.push(
                `The repeat at ${r.from.toLocaleString('en-US')} jumps back to its count's own byte (${data[r.to]}), not the command after it: from the second time round the player reads that byte as ${data[r.to] < 0x80 ? 'a note' : 'a command'}, and what follows out of step.`
            );
        if (runaways.length) warnings.push(`${plural(runaways.length, 'program runs', 'programs run')} off the end of the file without a stop.`);
        if (unknown.length)
            warnings.push(
                `${unknown.length === 1 ? 'The command' : 'Commands'} at ${unknown
                    .sort((a, b) => a - b)
                    .slice(0, 8)
                    .map((a) => `${a.toLocaleString('en-US')} (${hex2(data[a])})`)
                    .join(', ')}${unknown.length > 8 ? ` and ${unknown.length - 8} more` : ''} ${unknown.length === 1 ? 'isn’t one' : 'aren’t ones'} the player has: it stops the voice there.`
            );
        if (missingPrograms.size)
            warnings.push(
                `Commands start or wait for program${missingPrograms.size === 1 ? '' : 's'} ${[...missingPrograms].join(', ')}, which ${missingPrograms.size === 1 ? 'isn’t' : 'aren’t'} there: Dune II’s player would start one from the bytes the empty entry points to.`
            );
        if (missingInstruments.size)
            warnings.push(
                `Commands use instrument${missingInstruments.size === 1 ? '' : 's'} ${[...missingInstruments].join(', ')}, which ${missingInstruments.size === 1 ? 'isn’t' : 'aren’t'} there: Dune II’s player would set up the voice from the bytes the empty entry points to.`
            );

        // Every byte of the data: program headers, commands, instruments, and what nothing reaches. A byte read two ways is called out.
        // Instruments may share bytes (Westwood's tools packed some into others' tails), and a long loop's count is read again as
        // "Nothing" (see the repeats): neither is a clash. What's read out of step is warned about with its repeat.
        const owner = new Int32Array(reach).fill(-1);
        const ownerKind = new Uint8Array(reach);
        const CODE = 1;
        const INSTRUMENT_BYTE = 2;
        const QUIET = 3;
        let clashes = 0;
        const claim = (from: number, length: number, id: number, kind = CODE) => {
            for (let i = from; i < Math.min(from + length, reach); i++) {
                const before = ownerKind[i];
                if (before && owner[i] !== id && before !== QUIET && kind !== QUIET && !(before === INSTRUMENT_BYTE && kind === INSTRUMENT_BYTE)) clashes++;
                if (!before || kind !== QUIET) {
                    owner[i] = id;
                    ownerKind[i] = kind;
                }
            }
        };

        const programFields: Field[] = [];
        const startsAt = new Map<number, number[]>();
        programs.forEach((at, n) => {
            if (at !== null && inData(at)) startsAt.set(at, [...(startsAt.get(at) ?? []), n]);
        });
        const voices = new Map<number, number>();
        const inTrack = new Map<number, number[]>();
        tracks.forEach((p, t) => p !== null && inTrack.set(p, [...(inTrack.get(p) ?? []), t]));
        const placed = new Set<number>();
        /** The commands that run on from one place, until the next isn't one. */
        const run = (from: number) => {
            const out: Command[] = [];
            for (let at = from; commands.has(at) && !placed.has(at);) {
                const c = commands.get(at)!;
                placed.add(at);
                out.push(c);
                at += c.length;
            }
            return out;
        };
        /** A long loop's count, which its repeat lands on and reads as "Nothing" (see the repeats): shown with its "Set the repeat count". */
        const isCountByte = (at: number) => commands.get(at)?.length === 1 && data[at] === 0xbb && commands.get(at - 1)?.name === 'Set the repeat count';
        const claimCommand = (c: Command) => claim(c.at, c.length, c.at, c.stray || isCountByte(c.at) ? QUIET : CODE);
        const commandField = (c: Command) =>
            field(
                c.name,
                c.at,
                c.length,
                c.value,
                c.stray
                    ? 'Read out of step, after a repeat lands on its count’s byte.'
                    : isCountByte(c.at + 1)
                      ? 'The repeat lands on this count (0xBB), which read as a command is "Nothing", so the loop runs on from the command after.'
                      : undefined
            );
        for (const [at, numbers] of [...startsAt].sort((a, b) => a[0] - b[0])) {
            const voice = data[at];
            const priority = data[at + 1];
            for (const n of numbers) voices.set(n, voice);
            if (voice > 9) warnings.push(`Program ${numbers.join(' and ')} is for voice ${voice}; there are 10 (0 to 8, and 9, the conductor): the player ignores it.`);
            const body = run(at + 2);
            const length = body.length ? body.at(-1)!.at + body.at(-1)!.length - at : 2;
            claim(at, 2, at);
            for (const c of body) claimCommand(c);
            const tracksOf = numbers.flatMap((n) => inTrack.get(n) ?? []);
            programFields.push({
                name: `Program ${numbers.join(', ')}`,
                offset: at,
                length,
                value: `${voice === 9 ? 'the conductor' : `voice ${voice}`}, ${plural(body.length, 'command')}`,
                note: tracksOf.length ? `Track ${tracksOf.join(', ')}.` : startedPrograms.has(numbers[0]) ? 'Started by another program.' : 'No track or program starts it.',
                children: [
                    field('Voice', at, 1, voice === 9 ? '9: the conductor' : voice, 'Which of the chip’s voices it plays on; 9 starts the others and keeps the beat.'),
                    field('Priority', at + 1, 1, priority, 'It takes the voice only from a program of the same or lower priority.'),
                    ...body.map(commandField),
                ],
            });
        }
        // Commands only a jump, repeat or call reaches, in runs.
        for (const at of [...commands.keys()].sort((a, b) => a - b)) {
            if (placed.has(at) || isCountByte(at)) continue;
            const body = run(at);
            for (const c of body) claimCommand(c);
            programFields.push({
                name: 'Commands',
                offset: at,
                length: body.at(-1)!.at + body.at(-1)!.length - at,
                value: plural(body.length, 'command'),
                note: 'Reached by a jump, a repeat or a call.',
                children: body.map(commandField),
            });
        }
        // The instruments.
        const instrumentStarts = new Map<number, number[]>();
        instruments.forEach((at, n) => {
            if (at !== null && inData(at) && at + INSTRUMENT_SIZE <= reach) instrumentStarts.set(at, [...(instrumentStarts.get(at) ?? []), n]);
        });
        for (const [at, numbers] of instrumentStarts) {
            claim(at, INSTRUMENT_SIZE, at, INSTRUMENT_BYTE);
            const used = numbers.some((n) => usedInstruments.has(n));
            programFields.push({
                name: `Instrument ${numbers.join(', ')}`,
                offset: at,
                length: INSTRUMENT_SIZE,
                value: used ? 'used' : 'not used',
                children: INSTRUMENT_BYTES.map(([name, note], i) => field(name, at + i, 1, hex2(data[at + i]), note)),
            });
        }
        if (clashes) warnings.push(`${bytesLabel(clashes)} of the data are read two ways (as a program's commands, its start, or an instrument): something points into the middle of something else.`);

        // What nothing reaches: leftovers of Westwood's tools in every real file (a stop after a jump, an instrument no table
        // points to, a buffer's old contents at the end), so it's shown, not warned about.
        programFields.sort((a, b) => a.offset - b.offset);
        const dataFields: Field[] = [];
        let covered = dataStart;
        let unreached = 0;
        let places = 0;
        for (const f of programFields) {
            if (f.offset > covered) {
                dataFields.push(field('Not reached', covered, f.offset - covered, bytesLabel(f.offset - covered), 'Nothing points here or runs into it.'));
                unreached += f.offset - covered;
                places++;
            }
            dataFields.push(f);
            covered = Math.max(covered, f.offset + f.length);
        }
        if (covered < reach) {
            dataFields.push(field('Not reached', covered, reach - covered, bytesLabel(reach - covered), 'Nothing points here or runs into it.'));
            unreached += reach - covered;
            places++;
        }

        // The tables.
        const trackTable: Field = {
            name: 'Tracks',
            offset: 0,
            length: base,
            value: plural(tracks.filter((t) => t !== null).length, 'track'),
            note: `Which program each track starts; ${trackBytes === 1 ? '0xFF' : '0xFFFF'}: none.`,
            children: tracks.flatMap((p, t) => (p === null ? [] : [field(`Track ${t}`, t * trackBytes, trackBytes, `program ${p}`)])),
        };
        const offsetTable = (name: string, list: (number | null)[], from: number, what: string): Field => ({
            name,
            offset: from,
            length: list.length * 2,
            value: plural(list.filter((a) => a !== null).length, what),
            note: `Where each ${what} is, from the end of the track table; 0 or 0xFFFF: none.`,
            children: list.flatMap((at, n) => (at === null ? [] : [field(`${what[0].toUpperCase()}${what.slice(1)} ${n}`, from + n * 2, 2, `at ${at.toLocaleString('en-US')}`)])),
        });

        // An outline: each track, the program it starts, and what that one starts.
        const outline: string[] = [];
        const stem = context.name?.replace(/\.[^.]+$/, '').toUpperCase() ?? '';
        const music = DUNE2_MUSIC[stem];
        tracks.forEach((p, t) => {
            if (p === null) return;
            const at = programAt(p);
            const voice = voices.get(p);
            const started: number[] = [];
            if (at !== null)
                for (let a = at + 2; commands.has(a); a += commands.get(a)!.length) {
                    const c = commands.get(a)!;
                    if (c.starts !== undefined) started.push(c.starts);
                    if (c.ends) break;
                }
            const what = voice === undefined ? '(not there)' : voice === 9 ? 'the conductor' : `voice ${voice}`;
            const starts = started.length ? `, starting ${started.map((s) => `${s} (${voices.get(s) === 9 ? 'the conductor' : `voice ${voices.get(s) ?? '?'}`})`).join(', ')}` : '';
            outline.push(`Track ${t}${music?.includes(t) ? ' (music in the game)' : ''}: program ${p}, ${what}${starts}`);
        });

        const summary: [string, string][] = [
            ['Version', version === 1 ? '1 (Eye of the Beholder)' : version === 4 ? '4 (Kyrandia 2 and 3, Lands of Lore)' : `2 or 3 (Eye of the Beholder II, Kyrandia, Dune II)`],
            ['Tracks', plural(tracks.filter((t) => t !== null).length, 'track')],
            ['Programs', `${programs.filter((p) => p !== null).length}, ${plural(commands.size, 'command')}`],
            ['Instruments', `${instruments.filter((i) => i !== null).length} (${usedInstruments.size} used)`],
        ];
        if (version === 2)
            summary.push([
                'Calls',
                calls.length ? `${plural(calls.length, 'call')}, counted ${callsRelative ? 'from after each (version 3)' : 'from the data (version 2)'}` : 'None, so versions 2 and 3 read it alike',
            ]);
        if (missingTracks.length) summary.push(['Tracks with nothing', `${missingTracks.join(', ')}: their programs aren’t in the file (as in some of Westwood’s own)`]);
        if (music) {
            const here = music.filter((t) => tracks[t] !== null && tracks[t] !== undefined);
            const gone = music.filter((t) => !here.includes(t));
            const list = (ts: number[]) => (ts.length === 1 ? `track ${ts[0]}` : `tracks ${ts.join(', ')}`);
            const played = here.length ? `It plays ${list(here)} as music` : 'It plays none of its tracks as music';
            summary.push(['In Dune II', `${played}${gone.length ? `, and asks for ${list(gone)}, which ${gone.length === 1 ? 'isn’t' : 'aren’t'} here` : ''} (OpenDUNE’s table)`]);
        }
        if (unreached) summary.push(['Not reached', `${bytesLabel(unreached)} in ${plural(places, 'place')}: leftovers nothing points to`]);

        return {
            title: 'AdLib music (Westwood ADL)',
            summary,
            fields: [trackTable, offsetTable('Program offsets', programs, base, 'program'), offsetTable('Instrument offsets', instruments, base + programs.length * 2, 'instrument'), ...dataFields],
            preview: { kind: 'text', text: outline.join('\n') },
            // The player reaches no further; the usual checks look at anything after.
            end: Math.max(reach, covered),
            warnings,
        };
    },
};

export default parser;
