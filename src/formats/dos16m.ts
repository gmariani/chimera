import { Bytes, bytesLabel, field, hex } from '../core/bytes';
import type { Entry, Field } from '../core/types';

/**
 * Rational Systems' DOS/16M, and DOS/4GW, the DOS extender built on it that Watcom C shipped and most 32-bit DOS games
 * of the 1990s ran under: a DOS program (the loader, which switches the processor into protected mode) with the
 * extender's own modules bound after it, each in DOS/16M's format, then the program they run.
 *
 * Each module starts with a 176-byte header: "BW", then fields laid out as an MZ header's (the size in 512-byte
 * pages, memory, the stack, where it starts), then DOS/16M's own (where the next header is, from the start of the
 * file; the selectors and memory it wants; its options and flags), and the module's name. The extender's modules have
 * names ending .EXP: VMM.EXP (virtual memory), 4GWPRO.EXP (DOS/4GW Professional itself), CFG4GPRO.EXP (its settings).
 * After the last, the program itself: a DOS header whose newer-header field points to its 32-bit code, a Linear
 * Executable ("LE"), which isn't read here yet.
 *
 * The header's fields are from Open Watcom's exe16m.h (https://github.com/open-watcom/open-watcom-v2, bld/watcom/h;
 * Sybase Open Watcom Public License, so facts only). That the modules chain this way, and end with the bound program,
 * was worked out from the files: Tiberian Dawn's and Counterstrike's README.EXE and _SETUP.EXE, Counterstrike's
 * LICENSE.EXE.
 */

const HEADER = 0xb0;

const EXP_FLAGS: [number, string][] = [
    [0x0001, 'auto'],
    [0x0002, 'package'],
    [0x0004, 'no "big foot"'],
    [0x2000, 'shares data'],
    [0x4000, 'shareable'],
    [0x8000, 'DOS/4G'],
];
const OPTIONS: [number, string][] = [
    [0x0002, 'no VCPI'],
    [0x0004, 'keyboard'],
    [0x0008, 'overload'],
    [0x0010, 'INT 10h'],
    [0x0020, 'memory filled with 00'],
    [0x0040, 'memory filled with FF'],
    [0x0080, 'rotate'],
    [0x1000, 'auto'],
];
const STRATEGIES = ['prefers extended memory', 'prefers low memory', 'extended memory only', 'low memory only'];

/** What the extender's modules are, by name, as the files show them. */
const KNOWN: Record<string, string> = {
    'VMM.EXP': 'virtual memory manager',
    '4GWPRO.EXP': 'DOS/4GW Professional, the extender itself',
    'CFG4GPRO.EXP': 'DOS/4GW Professional’s settings',
};

const words = (value: number, names: [number, string][]) =>
    names
        .filter(([bit]) => value & bit)
        .map(([, w]) => w)
        .join(', ') || 'none';

export interface Dos16m {
    fields: Field[];
    entries: Entry[];
    /** The modules' names, in order. */
    modules: string[];
    /** The program the extender runs, when it's bound after the modules. */
    program: { at: number; codeAt: number; kind: string } | null;
    /** Where what's read ends. */
    end: number;
    problems: string[];
}

/** DOS/16M's modules starting at `from` (where the loader's image ends), and the program bound after them; null when there's no "BW" there. */
export function readDos16m(data: Uint8Array, from: number, stem: string, { alone = false }: { alone?: boolean } = {}): Dos16m | null {
    const b = new Bytes(data);
    if (b.ascii(from, 2) !== 'BW' || from + HEADER > data.length) return null;
    const fields: Field[] = [];
    const entries: Entry[] = [];
    const modules: string[] = [];
    const problems: string[] = [];
    let p = from;
    let end = from;
    // Each module is a header at least, and each points past itself, so the chain can't be longer than the file holds.
    for (let n = 0; n < data.length / HEADER && b.ascii(p, 2) === 'BW' && p + HEADER <= data.length; n++) {
        const next = b.u32(p + 0x1c);
        const name = b.asciiz(p + 0x70).text.slice(0, 64);
        // A module saved on its own runs to its end; where the next one was is in the file it was bound into.
        const to = !alone && next > p + HEADER && next <= data.length ? next : data.length;
        if (!alone && next && to !== next)
            problems.push(
                `${name || 'A DOS/16M module'} says the next one is at ${next.toLocaleString('en-US')}, ${next <= p ? 'not after it' : 'past the end of the file'}: it’s taken to run to the end.`
            );
        const u16 = (o: number) => b.u16(p + o);
        const flags = u16(0x34);
        const strategy = data[p + 0x3c];
        const header: Field[] = [
            field('Signature', p, 2, '"BW"', 'A DOS/16M module.'),
            field('Last page', p + 2, 2, bytesLabel(u16(2)), 'As an MZ header counts its size: the bytes in its last 512-byte page.'),
            field('Pages', p + 4, 2, u16(4)),
            field('Reserved', p + 6, 4, `${u16(6)}, ${u16(8)}`),
            field('Least memory', p + 0x0a, 2, `${bytesLabel(u16(0x0a) * 16)} more`),
            field('Most memory', p + 0x0c, 2, u16(0x0c) === 0xffff ? 'as much as there is' : `${bytesLabel(u16(0x0c) * 16)} more`),
            field('Stack', p + 0x0e, 4, `${hex(u16(0x0e), 4)}:${hex(u16(0x10), 4)}`, 'Its selector and offset.'),
            field('First relocation selector', p + 0x12, 2, `0x${hex(u16(0x12), 4)}`),
            field('Starts at', p + 0x14, 4, `${hex(u16(0x16), 4)}:${hex(u16(0x14), 4)}`, 'Its code selector and offset.'),
            field('Descriptor table size', p + 0x18, 2, bytesLabel(u16(0x18)), 'The selectors it needs while it runs.'),
            field('MAKEPM version', p + 0x1a, 2, `0x${hex(u16(0x1a), 4)}`, 'The version of the tool that made it a DOS/16M module.'),
            field('Next module at', p + 0x1c, 4, next ? next.toLocaleString('en-US') : 'none', alone ? 'In the file it was bound into, from its start.' : 'From the start of the file.'),
            field(
                'Debug info at',
                p + 0x20,
                4,
                b.u32(p + 0x20).toLocaleString('en-US'),
                p + b.u32(p + 0x20) === to ? 'From the start of the module: where it ends, so it has none.' : 'From the start of the module.'
            ),
            field('Last selector used', p + 0x24, 2, `0x${hex(u16(0x24), 4)}`),
            field('Own extended memory', p + 0x26, 2, u16(0x26) ? `${u16(0x26).toLocaleString('en-US')} KB` : 'none', 'Memory kept for it alone.'),
            field('Grows by', p + 0x28, 2, u16(0x28) ? `${u16(0x28).toLocaleString('en-US')} KB` : 'the default'),
            field('Reserved', p + 0x2a, 6, bytesLabel(6)),
            field('Options', p + 0x30, 2, words(u16(0x30), OPTIONS)),
            field('Transfer stack selector', p + 0x32, 2, `0x${hex(u16(0x32), 4)}`),
            field('Flags', p + 0x34, 2, words(flags, EXP_FLAGS)),
            field('Program size', p + 0x36, 2, u16(0x36)),
            field('Descriptor table image', p + 0x38, 2, bytesLabel(u16(0x38))),
            field('First selector', p + 0x3a, 2, `0x${hex(u16(0x3a), 4)}`),
            field('Memory', p + 0x3c, 1, STRATEGIES[strategy] ?? `strategy ${strategy}`),
            field('Reserved', p + 0x3d, 1, data[p + 0x3d]),
            field('Transfer buffer', p + 0x3e, 2, u16(0x3e) ? bytesLabel(u16(0x3e)) : '8 KB (the default)', 'For passing data to and from DOS.'),
            field('Reserved', p + 0x40, 48, bytesLabel(48)),
            field('Name', p + 0x70, 64, name || '(none)', 'The module’s file name before it was bound.'),
        ];
        fields.push({
            name: `DOS/16M module ${name || modules.length + 1}`,
            offset: p,
            length: to - p,
            value: KNOWN[name.toUpperCase()] ?? bytesLabel(to - p),
            note: 'Bound after the DOS loader, which loads it in protected mode.',
            children: [
                { ...field('Header', p, HEADER, `"BW", ${name || 'no name'}`), children: header },
                field('Module', p + HEADER, to - p - HEADER, bytesLabel(to - p - HEADER), 'Its descriptor table, code and data, which DOS/16M loads. Not read here.'),
            ],
        });
        if (!alone) entries.push({ name: name || null, label: name || `module-${modules.length + 1}.exp`, offset: p, size: to - p, data: data.subarray(p, to), meta: { Type: 'DOS/16M module' } });
        modules.push(name);
        end = to;
        if (to === data.length || to !== next) break;
        p = next;
    }

    // The program: a DOS header whose newer-header field points to its 32-bit code.
    let program: Dos16m['program'] = null;
    if (end + 0x40 <= data.length && b.ascii(end, 2) === 'MZ') {
        const at = end;
        const newer = b.u32(at + 0x3c);
        const codeAt = at + newer;
        const kind = codeAt + 2 <= data.length && newer >= 0x40 ? b.ascii(codeAt, 2) : '';
        if (kind === 'LE' || kind === 'LX') {
            const pages = b.u16(at + 4);
            const stub = Math.min(codeAt, at + (pages ? (pages - 1) * 512 + (b.u16(at + 2) || 512) : 0x40));
            program = { at, codeAt, kind };
            const parts: Field[] = [field('DOS header and stub', at, stub - at, bytesLabel(stub - at), 'Its newer-header field says where the 32-bit code is.')];
            if (codeAt > stub) {
                const zeros = data.subarray(stub, codeAt).every((v) => v === 0);
                parts.push(field(zeros ? 'Padding' : 'Not read', stub, codeAt - stub, bytesLabel(codeAt - stub)));
            }
            parts.push(field(`Linear Executable (${kind})`, codeAt, data.length - codeAt, bytesLabel(data.length - codeAt), 'The 32-bit program the extender runs. Not read here yet.'));
            fields.push({
                name: 'Bound program',
                offset: at,
                length: data.length - at,
                value: `32-bit (${kind}), ${bytesLabel(data.length - at)}`,
                note: 'What the extender loads and runs.',
                children: parts,
            });
            entries.push({
                name: null,
                label: `${stem}-program.exe`,
                offset: at,
                size: data.length - at,
                data: data.subarray(at),
                meta: { Type: `32-bit program (${kind}), which the extender runs` },
            });
            end = data.length;
        }
    }
    return { fields, entries, modules, program, end, problems };
}
