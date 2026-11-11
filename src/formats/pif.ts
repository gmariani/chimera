import { Bytes, bytesLabel, field } from '../core/bytes';
import type { Field, FormatParser } from '../core/types';
import { BASIC_SIZE, pifSections } from './pif-sniff';

/**
 * Windows' program information files (.pif): how to run a DOS program. First
 * the basic section TopView and Windows 1 and 2 used, 0x171 bytes: the
 * window's title, the memory it needs, the program, the folder to start in,
 * its parameters, the screen. From Windows 3.0, sections follow, each a
 * 16-character name, where the next one is, and where its data is and how
 * long: "MICROSOFT PIFEX" (the basic section itself), "WINDOWS 286 3.0"
 * (standard mode), "WINDOWS 386 3.0" (enhanced mode), "WINDOWS VMM 4.0"
 * (Windows 95), "WINDOWS NT  3.1" and "WINDOWS NT  4.0".
 *
 * Windows runs a .pif by what's in it, not by its name: a program named .pif
 * runs as one (the usual checks call that out). The sections' own fields
 * aren't documented anywhere this could check, so they're shown whole.
 * See https://en.wikipedia.org/wiki/Program_information_file.
 */

const SECTIONS: Record<string, { name: string; size?: number }> = {
    'MICROSOFT PIFEX': { name: 'The basic section, for every Windows', size: BASIC_SIZE },
    'WINDOWS 286 3.0': { name: 'Windows 3 standard mode', size: 6 },
    'WINDOWS 386 3.0': { name: 'Windows 3 enhanced mode (and 95 to 2000)', size: 0x68 },
    'WINDOWS VMM 4.0': { name: 'Windows 95 and 98' },
    'WINDOWS NT  3.1': { name: 'Windows NT and 2000' },
    'WINDOWS NT  4.0': { name: 'Windows NT 4 and 2000' },
};

/** Text that ends in a NUL (or runs to its length), trimmed of the spaces it's padded with. */
function str(data: Uint8Array, at: number, length: number): string {
    const slice = data.subarray(at, at + length);
    const nul = slice.indexOf(0);
    return new TextDecoder('latin1').decode(nul < 0 ? slice : slice.subarray(0, nul)).trimEnd();
}

/** Runs of 4 or more printable characters: what a section names (fonts, libraries) when its fields aren't decoded. */
function readable(data: Uint8Array, from: number, to: number): string[] {
    const out: string[] = [];
    let run = '';
    for (let i = from; i < to; i++) {
        const c = data[i];
        if (c >= 0x20 && c < 0x7f) run += String.fromCharCode(c);
        else {
            if (run.trim().length >= 4) out.push(run.trim());
            run = '';
        }
    }
    if (run.trim().length >= 4) out.push(run.trim());
    return out;
}

const parser: FormatParser = {
    parse(data) {
        if (data.length < BASIC_SIZE) throw new Error(`A program information file is at least ${BASIC_SIZE} bytes (its basic section); this is ${bytesLabel(data.length)}.`);
        const b = new Bytes(data);
        const warnings: string[] = [];
        const sections = pifSections(data);
        if (!sections && data.length > BASIC_SIZE) throw new Error("This isn't a program information file: after the basic section there's no list of sections that fits the file.");

        // The basic section: everything in it is shown, under any Windows.
        const title = str(data, 0x02, 30);
        const program = str(data, 0x24, 63);
        const folder = str(data, 0x65, 64);
        const parameters = str(data, 0xa5, 64);
        const flags = b.u16(0x63);
        let sum = 0;
        for (let i = 2; i < BASIC_SIZE; i++) sum += data[i];
        if (!program) warnings.push("It doesn't name a program to run.");
        else if (!/^[\x20-\x7e]+$/.test(program)) warnings.push('The program’s name has characters a DOS name can’t.');

        const basic: Field = {
            name: 'Basic section',
            offset: 0,
            length: BASIC_SIZE,
            value: title || '(no title)',
            note: 'What TopView and every Windows read.',
            children: [
                field('Reserved', 0, 1, data[0]),
                field('Checksum', 1, 1, data[1], `The sum of the bytes after it, to 0x170, would be ${sum & 0xff}. Windows 3.1 and later don’t check it, and don't keep it up to date.`),
                field('Title', 2, 30, JSON.stringify(title), 'Padded with spaces.'),
                field('Memory, most', 0x20, 2, `${b.u16(0x20)} KB`),
                field('Memory, least', 0x22, 2, `${b.u16(0x22)} KB`, 'What the program needs to start.'),
                field('Program', 0x24, 63, JSON.stringify(program), 'What runs. Ending in a NUL, padded with spaces.'),
                field('Flags', 0x63, 2, `0x${flags.toString(16).padStart(4, '0')}`, 'Bit 4: close the window when the program ends.'),
                field('Start in', 0x65, 64, JSON.stringify(folder), 'The folder it starts in.'),
                field('Parameters', 0xa5, 64, JSON.stringify(parameters), 'What it’s given to run with (under standard mode; enhanced mode has its own).'),
                field('Video mode', 0xe5, 1, data[0xe5]),
                field('Screen pages', 0xe6, 1, data[0xe6]),
                field('Interrupts, first and last', 0xe7, 2, `${data[0xe7]} to ${data[0xe8]}`, 'The interrupt vectors Windows saves and puts back.'),
                field('Rows and columns', 0xe9, 2, `${data[0xe9]} × ${data[0xea]}`),
                field('Other settings', 0xeb, 4, Array.from(data.subarray(0xeb, 0xef), (v) => v.toString(16).padStart(2, '0')).join(' '), 'Window position and memory, for TopView.'),
                field('Shared program', 0xef, 64, JSON.stringify(str(data, 0xef, 64)), 'For TopView.'),
                field('Shared data', 0x12f, 64, JSON.stringify(str(data, 0x12f, 64)), 'For TopView.'),
                field('Other flags', 0x16f, 2, `0x${b.u16(0x16f).toString(16).padStart(4, '0')}`),
            ],
        };

        // The sections: each header names its data, which is shown whole (but for the basic section's, above).
        const fields: Field[] = [basic];
        const names: string[] = [];
        for (const s of sections ?? []) {
            const known = SECTIONS[s.name];
            names.push(known ? `${s.name} (${known.name})` : s.name);
            if (!known) warnings.push(`There's a section "${s.name}", which no Windows defines; none would read it.`);
            if (known?.size !== undefined && s.length !== known.size) warnings.push(`The "${s.name}" section is ${bytesLabel(s.length)}; it's always ${bytesLabel(known.size)}.`);
            if (s.name === 'MICROSOFT PIFEX' && s.dataAt !== 0) warnings.push('The "MICROSOFT PIFEX" section should point at the basic section, at the start of the file.');
            fields.push({
                name: `Section header: ${s.name}`,
                offset: s.at,
                length: 22,
                value: s.next === 0xffff ? 'the last' : `next at ${s.next}`,
                children: [
                    field('Name', s.at, 16, JSON.stringify(s.name), 'Ending in a NUL.'),
                    field('Next header at', s.at + 16, 2, s.next === 0xffff ? '0xFFFF: none' : s.next),
                    field('Data at', s.at + 18, 2, s.dataAt),
                    field('Data length', s.at + 20, 2, bytesLabel(s.length)),
                ],
            });
            if (s.name !== 'MICROSOFT PIFEX' && s.length) {
                const names = readable(data, s.dataAt, s.dataAt + s.length);
                fields.push(
                    field(`${known?.name ?? s.name} settings`, s.dataAt, s.length, bytesLabel(s.length), `Its fields aren't decoded here.${names.length ? ` It names: ${names.join(', ')}.` : ''}`)
                );
            }
        }

        // Anything nothing points to, between and after.
        fields.sort((x, y) => x.offset - y.offset || y.length - x.length);
        const placed: Field[] = [];
        let covered = 0;
        let stray = 0;
        for (const f of fields) {
            if (f.offset > covered) {
                const gap = data.subarray(covered, f.offset);
                if (gap.some((v) => v)) stray += gap.length;
                placed.push(field(gap.some((v) => v) ? 'Not pointed to' : 'Padding', covered, gap.length, bytesLabel(gap.length)));
            }
            if (f.offset < covered) warnings.push(`${f.name} overlaps what comes before it.`);
            placed.push(f);
            covered = Math.max(covered, f.offset + f.length);
        }
        if (stray) warnings.push(`${bytesLabel(stray)} between the sections aren't pointed to by any header.`);

        return {
            title: 'Program information file (PIF)',
            summary: [
                ['Title', title || '(none)'],
                ['Runs', program || '(nothing)'],
                ...(parameters ? [['With', parameters] as [string, string]] : []),
                ['Starts in', folder || '(the program’s own folder)'],
                ['Memory', `${b.u16(0x22)} to ${b.u16(0x20)} KB`],
                ['Screen', `${data[0xe9]} rows × ${data[0xea]} columns`],
                ['When it ends', flags & 0x10 ? 'The window closes' : 'The window stays open'],
                ['Sections', names.length ? names.join('; ') : 'None: the basic section only (Windows 1 and 2, TopView)'],
            ],
            fields: placed,
            // Past the last section is nothing the file has; the usual checks look at it.
            end: covered,
            warnings,
        };
    },
};

export default parser;
