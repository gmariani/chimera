import { bytesLabel, field } from '../../core/bytes';
import type { Field, FormatParser } from '../../core/types';
import { COMMANDS } from './adl-layout';
import { drvLayout } from './drv-layout';

/**
 * Westwood's own sound drivers (.DRV), which Dune II loads for its AdLib
 * music and sound (ALFX.DRV, playing .ADL files) and for the PC speaker
 * (PCSOUND.DRV). Kyrandia's are built the same way. A driver is 16-bit x86
 * code, loaded at the start of a segment, so offsets in it count from the
 * start of the file:
 *
 * - Two jumps. The game calls the first, with a function's number in BX; the
 *   second is what its timer calls to move the music on.
 * - Where the first lands, a dispatcher: a number past the table returns at
 *   once, and any other jumps through the table to its function. Each ends in
 *   IRET, as an interrupt handler does.
 * - The code and its data. ALFX.DRV's player looks each music command up in a
 *   table of its own; PCSOUND.DRV keeps the PC timer's count for each note.
 *
 * The functions are named after ScummVM's reimplementation of Kyrandia's
 * driver (engines/kyra/sound/drivers/adlib.cpp), which takes the same 18 calls
 * with the same values. Function 1 gives the driver's size: ALFX.DRV's says
 * 6,517 bytes, which it is. How often the game's timer calls each is from
 * DUNE2.EXE's list of drivers. Nothing here runs the code.
 */

/** Each function, by number, and what it does (ScummVM's _driverProcs). */
const FUNCTIONS = [
    'The driver’s version',
    'The driver’s size',
    'Start the driver',
    'Stop the driver',
    'Take the music data',
    'Unknown',
    'Start a program (a song or a sound)',
    'Whether a voice is playing',
    'Stop the voices from one on',
    'Read a byte of a program',
    'Change a byte of a program',
    'The signal the music last sent',
    'Unknown',
    'Nothing',
    'Unknown',
    'Unknown',
    'Set flags',
    'Clear flags',
];
/** Dune II's drivers, and how often its timer calls each (DUNE2.EXE's list of music drivers). */
const DUNE2: Record<string, number> = { 'ALFX.DRV': 72, 'PCSOUND.DRV': 292 };
const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
/** The PC's timer runs at this many counts a second; the speaker's pitch is that over the count. */
const PIT = 1193182;
const hex = (v: number) => `0x${v.toString(16).toUpperCase().padStart(4, '0')}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** ALFX's player: and al,7Fh; cmp al,n; jng; mov al,n; mov bl,al; xor bh,bh; shl bl,1; call [cs:bx+table]. */
function commandTable(data: Uint8Array): { code: number; table: number; count: number } | null {
    const at = (i: number, bytes: number[]) => bytes.every((v, k) => v < 0 || data[i + k] === v);
    for (let i = 0; i + 19 <= data.length; i++)
        if (at(i, [0x24, 0x7f, 0x3c, -1, 0x7e, 0x02, 0xb0, -1, 0x8a, 0xd8, 0x32, 0xff, 0xd0, 0xe3, 0x2e, 0xff, 0x97]) && data[i + 3] === data[i + 7])
            return { code: i, table: data[i + 17] | (data[i + 18] << 8), count: data[i + 3] + 1 };
    return null;
}

/** A run of at least two octaves of timer counts, each a semitone above the last: the notes a PC speaker driver plays. */
function noteTable(data: Uint8Array): { at: number; counts: number[] } | null {
    const word = (i: number) => data[i] | (data[i + 1] << 8);
    const semitone = (a: number, b: number) => b > 0 && a / b > 1.05 && a / b < 1.07;
    for (let i = 6; i + 50 <= Math.min(data.length, 0x4000); i++) {
        let n = 1;
        while (i + (n + 1) * 2 <= data.length && semitone(word(i + (n - 1) * 2), word(i + n * 2))) n++;
        if (n >= 25) return { at: i, counts: Array.from({ length: n }, (_, k) => word(i + k * 2)) };
    }
    return null;
}

const pitch = (count: number) => {
    const hz = PIT / count;
    const midi = Math.round(69 + 12 * Math.log2(hz / 440));
    return `${hz.toLocaleString('en-US', { maximumFractionDigits: hz < 100 ? 2 : 1 })} Hz (${NOTES[midi % 12]}${Math.floor(midi / 12) - 1})`;
};

const parser: FormatParser = {
    parse(data, context) {
        const layout = drvLayout(data);
        if (typeof layout === 'string') throw new Error(`This isn't one of Westwood's sound drivers. ${layout}`);
        const { dispatcher, timer, table, functions, refused } = layout;
        const word = (i: number) => data[i] | (data[i + 1] << 8);
        const warnings: string[] = [];
        const commands = commandTable(data);
        const notes = commands ? null : noteTable(data);
        const name = (context.name ?? '').toUpperCase();
        const rate = DUNE2[name];

        /** The tables, which no function's code should be in. */
        const tables: [number, number][] = [
            [table, table + functions.length * 2],
            [dispatcher, dispatcher + 12],
            ...(commands ? [[commands.table, commands.table + commands.count * 2] as [number, number]] : []),
        ];
        const inTables = (at: number) => tables.some(([from, to]) => at >= from && at < to);

        // Each function: what its code does first. Most push the values they take, call the work, and return; some only return.
        let version = '';
        let size = -1;
        const functionFields: Field[] = functions.map((at, i) => {
            const entry = table + i * 2;
            const said = FUNCTIONS[i] ?? 'Unknown';
            let value = `code at ${hex(at)}`;
            let note: string | undefined;
            if (at >= data.length) warnings.push(`Function ${i} (${said}) is at ${hex(at)}, past the end of the file: calling it would run whatever is in memory after the driver.`);
            else if (inTables(at)) warnings.push(`Function ${i} (${said}) is at ${hex(at)}, inside the driver's tables: calling it would run them as code.`);
            else {
                let p = at;
                while (p < data.length && (data[p] === 0x50 || data[p] === 0x51 || data[p] === 0x52)) p++;
                const takes = p - at;
                if (data[p] === 0xcf && !takes) note = 'Not supported here: it returns at once.';
                else if (data[p] === 0x83 && data[p + 1] === 0xc4 && data[p + 3] === 0xcf) note = `Takes ${plural(takes, 'value')}, and does nothing with them.`;
                else if (data[p] === 0x0e && data[p + 1] === 0xe8) {
                    const work = (p + 4 + ((word(p + 2) << 16) >> 16)) & 0xffff;
                    // A function that only hands back a number: mov ax,n; retf.
                    const constant = data[work] === 0xb8 && data[work + 3] === 0xcb ? word(work + 1) : -1;
                    if (i === 0 && constant >= 0) version = `${constant >> 8}.${(constant & 0xff).toString(16).padStart(2, '0')}`;
                    if (i === 1 && constant >= 0) size = constant;
                    if (constant >= 0) value = i === 0 ? version : i === 1 ? bytesLabel(constant) : `${constant}`;
                    note = takes ? `Takes ${plural(takes, 'value')}.` : undefined;
                }
            }
            return { name: `${i}: ${said}`, offset: entry, length: 2, value, note };
        });
        if (size >= 0 && size !== data.length) warnings.push(`The driver says it's ${bytesLabel(size)}, but the file is ${bytesLabel(data.length)}.`);
        const supported = functionFields.filter((f) => f.note !== 'Not supported here: it returns at once.').length;

        const fields: Field[] = [
            field('Entry point', 0, 3, `jump to ${hex(dispatcher)}`, 'Where the game calls the driver, with a function’s number in BX.'),
            field(
                'Timer’s entry point',
                3,
                3,
                `jump to ${hex(timer)}`,
                rate ? `What Dune II’s timer calls, ${rate} times a second, to move the music on.` : 'What the game’s timer calls, to move the music on.'
            ),
            {
                name: 'Function table',
                offset: table,
                length: functions.length * 2,
                value: plural(functions.length, 'function'),
                note: 'Where each function’s code is, by number.',
                children: functionFields,
            },
            field(
                'Dispatcher',
                dispatcher,
                12,
                `${functions.length} functions`,
                `Takes the function’s number in BX: past ${functions.length - 1}, it goes to ${hex(refused)}${data[refused] === 0xcf ? ', which returns at once' : ''}.`
            ),
        ];
        if (commands) {
            const children: Field[] = [];
            for (let i = 0; i < commands.count; i++) {
                const at = word(commands.table + i * 2);
                if (commands.table + i * 2 + 2 > data.length) break;
                if (at >= data.length) warnings.push(`Music command 0x${(0x80 + i).toString(16).toUpperCase()}'s code is at ${hex(at)}, past the end of the file.`);
                children.push(field(`0x${(0x80 + i).toString(16).toUpperCase()}: ${COMMANDS[i]?.[0] || 'Unnamed'}`, commands.table + i * 2, 2, `code at ${hex(at)}`));
            }
            const last = (0x80 + commands.count - 1).toString(16).toUpperCase();
            fields.push({
                name: 'Music commands',
                offset: commands.table,
                length: Math.min(commands.count * 2, data.length - commands.table),
                value: plural(commands.count, 'command'),
                note: `Where the player’s code for each of the .ADL files’ commands is: bytes 0x80 to 0x${last}. Any above 0x${last} runs 0x${last}’s code.`,
                children,
            });
        }
        if (notes) {
            const { at, counts } = notes;
            fields.push(
                field(
                    'Note pitches',
                    at,
                    counts.length * 2,
                    `${plural(counts.length, 'note')}, ${pitch(counts[0])} to ${pitch(counts[counts.length - 1])}`,
                    `For each note, the PC timer’s count: the speaker sounds at ${PIT.toLocaleString('en-US')} Hz over it.`
                )
            );
        }

        // Everything else is the code and its data.
        fields.sort((a, b) => a.offset - b.offset);
        const placed: Field[] = [];
        let covered = 0;
        const code = (from: number, to: number) => field('Code and data', from, to - from, bytesLabel(to - from), '16-bit x86 code, and what it works with.');
        for (const f of fields) {
            if (f.offset > covered) placed.push(code(covered, f.offset));
            placed.push(f);
            covered = Math.max(covered, f.offset + f.length);
        }
        if (covered < data.length) placed.push(code(covered, data.length));

        return {
            title: 'Sound driver (Westwood DRV)',
            summary: [
                [
                    'Plays',
                    commands
                        ? 'AdLib music and sound effects (.ADL files)'
                        : notes
                          ? 'Music and sound on the PC speaker'
                          : 'Not known: it has neither an AdLib player’s commands nor a PC speaker’s notes',
                ],
                ...(version ? [['Version', version] as [string, string]] : []),
                ['Functions', `${functions.length} (${supported} it does something for)`],
                ...(size >= 0 ? [['Size', `${bytesLabel(size)}, as it says`] as [string, string]] : []),
                ...(rate ? [['Timer', `Called ${rate} times a second by Dune II`] as [string, string]] : []),
            ],
            fields: placed,
            // The code runs to the end of the file: there's nothing after it to mark.
            end: data.length,
            warnings,
        };
    },
};

export default parser;
