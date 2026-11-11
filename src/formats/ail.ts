import { bytesLabel, field } from '../core/bytes';
import type { Field, FormatParser } from '../core/types';
import { ailLayout } from './ail-sniff';

/**
 * Sound drivers for Miles Design's Audio Interface Library (AIL) 2, from 1991
 * and 1992: what DOS games such as Dune II, Kyrandia and Ultima Underworld
 * load to play music and sound on the player's card (MT32MPU.ADV for a Roland,
 * SBDIG.ADV for a Sound Blaster's digital sound...).
 *
 * A driver is 16-bit x86 code, loaded at the start of a segment, so offsets
 * in it count from the start of the file:
 *
 * - The first word is where the function table is. Before it is a line of
 *   text ending in 0x1A, the end of a DOS text file, so typing the driver at
 *   a DOS prompt shows only the copyright.
 * - The function table: a function number and where its code is, for each
 *   call the driver takes, ending with 0xFFFF. AIL looks a call up there by
 *   number, taking the first match.
 * - The description table that function 100 hands back: the AIL version it
 *   needs, whether it plays music (XMIDI) or digital sound, its usual I/O
 *   port, IRQ and DMA channel, how often it must be called, and where the
 *   names of the devices it drives are. Miles's drivers keep it right after
 *   the function table, and the device names right after it.
 * - The code and its data.
 *
 * Nothing here runs the code. This follows the AIL 2 source John Miles released
 * in 2000 (AIL.INC for the function numbers, AIL.H for the description table,
 * DMASOUND.ASM and MT32.INC for how a driver is laid out):
 * https://github.com/Tronix286/AIL2.
 */

/** Each call AIL 2 makes to a driver, by number (AIL.INC), and what it does. */
const FUNCTIONS: Record<number, string> = {
    100: 'Describe the driver',
    101: 'Detect the device',
    102: 'Start the driver',
    103: 'Service the driver (called on a timer)',
    104: 'Shut the driver down',
    120: 'Find a block in a VOC file',
    121: 'Register a sound buffer',
    122: 'A sound buffer’s status',
    123: 'Play a VOC file',
    124: 'VOC playback status',
    125: 'Start digital playback',
    126: 'Stop digital playback',
    127: 'Pause digital playback',
    128: 'Resume digital playback',
    129: 'Set the digital volume',
    130: 'The digital volume',
    131: 'Set the digital panning',
    132: 'The digital panning',
    133: 'Convert a VOC file for the card',
    134: 'Convert a sound buffer for the card',
    150: 'How much memory a sequence needs',
    151: 'Register a sequence',
    152: 'Release a sequence',
    153: 'The usual timbre cache size',
    154: 'Set up the timbre cache',
    155: 'Which timbre a sequence needs next',
    156: 'Install a timbre',
    157: 'Protect a timbre',
    158: 'Unprotect a timbre',
    159: 'A timbre’s status',
    170: 'Start a sequence',
    171: 'Stop a sequence',
    173: 'Resume a sequence',
    174: 'A sequence’s status',
    175: 'A sequence’s volume',
    176: 'A sequence’s tempo',
    177: 'Set a sequence’s volume',
    178: 'Set a sequence’s tempo',
    179: 'The beat count',
    180: 'The measure count',
    181: 'Branch to a marker',
    182: 'A controller’s value',
    183: 'Set a controller’s value',
    185: 'The notes playing on a channel',
    186: 'Send a MIDI channel message',
    187: 'Send a MIDI System Exclusive message',
    188: 'Write to the synthesizer’s display',
    189: 'Install a callback',
    190: 'Cancel the callback',
    191: 'Lock a channel',
    192: 'Map a sequence’s channel',
    193: 'Release a channel',
    194: 'The channel a sequence’s channel really plays on',
};

/** drvr_type (AIL.H). */
const TYPES: Record<number, string> = { 2: 'Digital sound (in the Sound Blaster’s way)', 3: 'Music (XMIDI)' };
const DESCRIPTION_SIZE = 24;
const hex = (v: number) => `0x${v.toString(16).toUpperCase().padStart(4, '0')}`;

const parser: FormatParser = {
    parse(data) {
        const layout = ailLayout(data);
        if (typeof layout === 'string') throw new Error(`This isn't a Miles sound driver (AIL 2). ${layout}`);
        const { table, functions, tableEnd } = layout;
        const word = (i: number) => data[i] | (data[i + 1] << 8);
        const warnings: string[] = [];
        const latin1 = new TextDecoder('latin1');
        const text = latin1.decode(data.subarray(2, table - 1));

        // The description table, where Miles's drivers keep it: right after the function table, pointing at the device names.
        const d = tableEnd;
        const namesAt = d + DESCRIPTION_SIZE <= data.length ? word(d + 8) : -1;
        const hasDescription = namesAt >= d + DESCRIPTION_SIZE && namesAt < data.length;
        // The device names: each ending in a NUL, the list ending with an empty one.
        const names: { at: number; text: string }[] = [];
        let namesEnd = namesAt;
        if (hasDescription) {
            let ended = false;
            while (namesEnd < data.length) {
                if (!data[namesEnd]) {
                    ended = true;
                    namesEnd++;
                    break;
                }
                const nul = data.indexOf(0, namesEnd);
                const stop = nul < 0 ? data.length : nul;
                names.push({ at: namesEnd, text: latin1.decode(data.subarray(namesEnd, stop)) });
                namesEnd = nul < 0 ? data.length : nul + 1;
            }
            if (!ended) warnings.push('The list of device names runs to the end of the file without the empty name that ends it.');
        }
        const type = hasDescription ? word(d + 2) : -1;
        const api = hasDescription ? word(d) : 0;
        if (hasDescription && !(type in TYPES)) warnings.push(`The driver says it's of type ${type}; AIL 2 knows only 2 (digital sound) and 3 (music).`);
        /** Whether an offset is in the tables rather than the code. */
        const inTables = (at: number) => at < (hasDescription ? d + DESCRIPTION_SIZE : tableEnd) || (hasDescription && at >= namesAt && at < namesEnd);

        // The functions: each one AIL can call, and where its code is.
        const seen = new Set<number>();
        const functionFields: Field[] = functions.map((f, i) => {
            const at = table + i * 4;
            const name = FUNCTIONS[f.number];
            let note = name ? undefined : 'Not a call AIL 2 makes: it’s never used.';
            if (!name) warnings.push(`Function ${f.number} isn't one AIL 2 calls, so it's never used.`);
            if (seen.has(f.number)) {
                warnings.push(`Function ${f.number} is listed twice; AIL uses the first.`);
                note = 'Listed before: AIL uses the first.';
            }
            seen.add(f.number);
            if (f.at >= data.length)
                warnings.push(`Function ${f.number} (${name ?? 'unknown'}) is at ${hex(f.at)}, past the end of the file: calling it would run whatever is in memory after the driver.`);
            else if (inTables(f.at)) warnings.push(`Function ${f.number} (${name ?? 'unknown'}) is at ${hex(f.at)}, inside the driver's tables: calling it would run them as code.`);
            return {
                name: `${f.number}: ${name ?? 'Unknown'}`,
                offset: at,
                length: 4,
                value: `code at ${hex(f.at)}`,
                note,
                children: [field('Function', at, 2, f.number), field('Code at', at + 2, 2, hex(f.at), 'From the start of the file.')],
            };
        });
        if (!seen.has(100)) warnings.push("There's no function 100 (Describe the driver), which AIL calls first: it would refuse to load the driver.");
        const music = functions.some((f) => f.number >= 150);
        const digital = functions.some((f) => f.number >= 120 && f.number < 150);

        const fields: Field[] = [
            field('Function table at', 0, 2, table),
            {
                name: 'Copyright',
                offset: 2,
                length: table - 2,
                value: JSON.stringify(text),
                children: [field('Text', 2, table - 3, JSON.stringify(text)), field('End of text', table - 1, 1, '0x1A', 'Where DOS stops typing a file, so only this line shows.')],
            },
            {
                name: 'Function table',
                offset: table,
                length: tableEnd - table,
                value: `${functions.length} functions`,
                note: 'What AIL can ask of the driver, each by number.',
                children: [...functionFields, field('End', tableEnd - 2, 2, '0xFFFF')],
            },
        ];
        if (hasDescription) {
            const port = (v: number) => (v === 0xffff ? 'None set: the driver finds it when it starts' : hex(v));
            const setting = (v: number) => (v === 0xffff ? 'None' : v);
            fields.push(
                {
                    name: 'Description',
                    offset: d,
                    length: DESCRIPTION_SIZE,
                    value: TYPES[type] ?? `type ${type}`,
                    note: 'What function 100 hands back.',
                    children: [
                        field('Needs AIL', d, 2, `${(api / 100).toFixed(2)} or later`),
                        field('Kind', d + 2, 2, TYPES[type] ? `${type}: ${TYPES[type]}` : type),
                        field(
                            'File suffix',
                            d + 4,
                            4,
                            JSON.stringify(String.fromCharCode(...data.subarray(d + 4, d + 8)).replace(/\0.*$/, '')),
                            'The files it reads itself: VOC sound, or its own instrument banks (.AD, .OPL, .MT).'
                        ),
                        field('Device names at', d + 8, 2, hex(namesAt)),
                        field('Device names segment', d + 10, 2, word(d + 10), 'Filled in when the driver is loaded.'),
                        field('I/O port', d + 12, 2, port(word(d + 12))),
                        field('IRQ', d + 14, 2, setting(word(d + 14))),
                        field('DMA channel', d + 16, 2, setting(word(d + 16))),
                        field('DRQ', d + 18, 2, setting(word(d + 18))),
                        field('Calls a second', d + 20, 2, word(d + 20) === 0xffff ? 'None: it needn’t be called on a timer' : word(d + 20), 'How often AIL calls function 103.'),
                        field('Display', d + 22, 2, word(d + 22) ? `${word(d + 22)} characters` : 'None', 'The synthesizer’s own screen (the MT-32 has 20 characters).'),
                    ],
                },
                {
                    name: 'Device names',
                    offset: namesAt,
                    length: namesEnd - namesAt,
                    value: `${names.length}`,
                    note: 'Each ending in a NUL; an empty one ends the list.',
                    children: names.map((n, i) => field(`Device ${i + 1}`, n.at, Math.min(n.text.length + 1, data.length - n.at), JSON.stringify(n.text))),
                }
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

        const sound = music && digital ? 'Music and digital sound' : music ? 'Music (XMIDI)' : digital ? 'Digital sound' : 'Neither music nor digital sound';
        return {
            title: 'Sound driver (Miles AIL 2)',
            summary: [
                ['For', names.length ? names.map((n) => n.text).join('; ') : '(its description isn’t where Miles’s drivers keep it)'],
                ['Plays', hasDescription && TYPES[type] ? TYPES[type] : sound],
                ['Functions', `${functions.length} (${functions.filter((f) => FUNCTIONS[f.number]).length} that AIL 2 calls)`],
                ...(hasDescription ? [['Needs', `AIL ${(api / 100).toFixed(2)} or later`] as [string, string]] : []),
                ['Copyright', text],
            ],
            fields: placed,
            // The code runs to the end of the file: there's nothing after it to mark.
            end: data.length,
            warnings,
        };
    },
};

export default parser;
