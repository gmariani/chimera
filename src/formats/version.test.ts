import { describe, expect, it } from 'vitest';
import type { Field, Parsed } from '../core/types';
import { versionNode, versionResource } from '../testing/samples';
import { detect } from './index';
import { inspect } from './inspect';
import version from './version';

const parse = (data: Uint8Array) => version.parse(data, { name: 'Version #1.bin', names: [] }) as Parsed;
const bytes = (b: number[]) => Uint8Array.from(b);
const pad4 = (b: number[]) => [...b, ...new Array((4 - (b.length % 4)) % 4).fill(0)];
/** A 16-bit (Windows 3) node: its length, its value's length, its key in plain text, then its value and children. */
function node16(key: string, value: number[], children: number[][] = []): number[] {
    const head = pad4([0, 0, 0, 0, ...[...key].map((c) => c.charCodeAt(0)), 0]);
    const body = [...head, ...pad4(value), ...children.flatMap(pad4)];
    return [body.length & 0xff, body.length >> 8, value.length & 0xff, value.length >> 8, ...body.slice(4)];
}
const covered = (fields: Field[]) => fields.reduce((n, f) => n + f.length, 0);
const find = (fields: Field[], name: string): Field | undefined => {
    for (const f of fields) {
        if (f.name === name) return f;
        const deeper = find(f.children ?? [], name);
        if (deeper) return deeper;
    }
};

describe('Windows version information', () => {
    it('reads what a program says about itself, marking every byte', async () => {
        const data = bytes(versionResource());
        expect(detect(data, 'Version #1.bin').id).toBe('version');
        expect(detect(data, null).id).toBe('version');
        const inspected = await inspect(data, { name: 'Version #1.bin', names: [] });
        expect(inspected.checks).toEqual([]);
        const r = inspected.parsed;
        expect(r.warnings).toEqual([]);
        expect(r.title).toBe('Version information (32-bit Windows resource)');
        expect(r.summary).toEqual([
            ['Description', 'Chimera sample program'],
            ['Company', 'Chimera'],
            ['Product', 'Chimera'],
            ['Version, as text', '1.0.0.0'],
            ['Original name', 'program-pe.exe'],
            ['File version', '1.0.0.0'],
            ['Product version', '1.0.0.0'],
            ['Strings', '5 in English (US), Unicode'],
            ['Languages', 'English (US), Unicode'],
        ]);
        expect(covered(r.fields)).toBe(data.length);
        expect(find(r.fields, 'Fixed numbers')?.children?.map((f) => [f.name, f.value])).toEqual([
            ['Signature', '0xFEEF04BD'],
            ['Layout version', '1.0'],
            ['File version', '1.0.0.0'],
            ['Product version', '1.0.0.0'],
            ['Flags that count', '0x3F'],
            ['Flags', 'none'],
            ['Made for', '32-bit Windows on Windows NT'],
            ['Kind', 'a program'],
            ['Subkind', 'none'],
            ['Date', 'none'],
        ]);
        expect(find(r.fields, 'CompanyName')).toMatchObject({ value: 'Chimera', note: 'Who made it.' });
        expect(find(r.fields, 'Strings in English (US), Unicode')?.value).toBe('5 strings');
    });

    it('reads 16-bit version information, whose text is in the code page and whose nodes have no type', () => {
        const fixed = [0xbd, 0x04, 0xef, 0xfe, 0, 0, 1, 0, 2, 0, 3, 0, 4, 0, 1, 0, ...new Array(36).fill(0)];
        const data = bytes(
            node16('VS_VERSION_INFO', fixed, [
                node16('StringFileInfo', [], [node16('040904E4', [], [node16('CompanyName', [...'Westwood'].map((c) => c.charCodeAt(0)).concat(0))])]),
                node16('VarFileInfo', [], [node16('Translation', [0x09, 0x04, 0xe4, 0x04])]),
            ])
        );
        expect(detect(data, null).id).toBe('version');
        const r = parse(data);
        expect(r.warnings).toEqual([]);
        expect(r.title).toBe('Version information (16-bit Windows resource)');
        expect(r.summary).toEqual(
            expect.arrayContaining([
                ['Company', 'Westwood'],
                ['File version', '3.2.1.4'],
                ['Languages', 'English (US), Windows Western'],
            ])
        );
        expect(covered(r.fields)).toBe(data.length);
    });

    it('refuses what isn’t version information', () => {
        const data = bytes(versionResource());
        data[8] = 0x58;
        expect(detect(data, 'Version #1.bin').id).not.toBe('version');
        expect(() => parse(data)).toThrow('This isn’t a Windows version resource: it doesn’t start with VS_VERSION_INFO.');
    });

    it('says what doesn’t fit', () => {
        const signature = bytes(versionResource());
        signature[40] ^= 1;
        expect(parse(signature).warnings).toEqual(['Its version numbers don’t start with the signature Windows looks for (0xFEEF04BD), so Windows ignores them.']);

        // The padding after the root's key, made something else.
        const stray = bytes(versionResource());
        stray[38] = 1;
        expect(parse(stray).warnings).toEqual(['The version information has bytes nothing in it accounts for, in one place.']);
        expect(find(parse(stray).fields, 'Not read')).toMatchObject({ offset: 38, length: 2 });

        // VarFileInfo, the root's last part, said to run past the root's end.
        const long = bytes(versionResource());
        const last = new TextDecoder('utf-16le').decode(long).indexOf('VarFileInfo') * 2 - 6;
        long[last + 1] = 0x10;
        expect(parse(long).warnings).toEqual(['One part of the version information says it’s longer than what holds it: it was read only that far.']);

        const named = bytes(versionNode('VS_VERSION_INFO', 0, [], [versionNode('StringFileInfo', 1, [], [versionNode('ENGLISH!', 1, [], [])])]));
        expect(parse(named).warnings).toEqual(['A string table in the version information is named "ENGLISH!", not a language and code page as 8 hex digits, so Windows won’t find its strings.']);

        let deep = versionNode('X', 1, [0x41, 0]);
        for (let i = 0; i < 6; i++) deep = versionNode('X', 1, [], [deep]);
        const tooDeep = bytes(versionNode('VS_VERSION_INFO', 0, [], [deep]));
        expect(parse(tooDeep).warnings).toEqual(['The version information goes deeper than Windows reads; what’s below wasn’t read.']);
        expect(covered(parse(tooDeep).fields)).toBe(tooDeep.length);
    });
});
