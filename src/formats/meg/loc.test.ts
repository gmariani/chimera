import { describe, expect, it } from 'vitest';
import { crc32 } from '../../core/crc32';
import { detect } from '../index';
import loc from './loc';

/** A LOC holding the given strings, in the order given. */
function build(strings: [key: string, value: string][]): Uint8Array {
    const keys = strings.map(([k]) => new TextEncoder().encode(k));
    const valuesLength = strings.reduce((n, [, v]) => n + v.length * 2, 0);
    const keysLength = keys.reduce((n, k) => n + k.length, 0);
    const valuesStart = 4 + strings.length * 12;
    const out = new Uint8Array(valuesStart + valuesLength + keysLength);
    const view = new DataView(out.buffer);
    view.setUint32(0, strings.length, true);
    let valueAt = valuesStart;
    let keyAt = valuesStart + valuesLength;
    strings.forEach(([, value], i) => {
        const key = keys[i];
        view.setUint32(4 + i * 12, crc32(key), true);
        view.setUint32(8 + i * 12, value.length, true);
        view.setUint32(12 + i * 12, key.length, true);
        for (let c = 0; c < value.length; c++) view.setUint16(valueAt + c * 2, value.charCodeAt(c), true);
        out.set(key, keyAt);
        valueAt += value.length * 2;
        keyAt += key.length;
    });
    return out;
}

const parse = (data: Uint8Array) => loc.parse(data, { name: null, names: [] });
const text = (data: Uint8Array) => {
    const preview = parse(data).preview;
    if (preview?.kind !== 'text') throw new Error('Expected a text preview.');
    return preview.text;
};

describe('LOC string tables', () => {
    const strings: [string, string][] = [
        ['TEXT_MUSIC_TDR_MUS_RECON', 'ReCon (Remastered)'],
        ['TEXT_MUSIC_RAB_MUS_BIG_FOOT_FKTS', 'Big Foot – Tiberian Sons (Bonus)'],
    ];

    it('is found by its shape, whatever the name', () => {
        expect(detect(build(strings), 'MASTERTEXTFILE_EN-US.LOC').id).toBe('loc');
        expect(detect(build(strings), 'CREDITSTEXT_EN-US.DAT').id).toBe('loc');
        expect(detect(build(strings), null).id).toBe('loc');
    });

    it("isn't found in a file whose sizes or first CRC don't add up", () => {
        const extra = new Uint8Array(build(strings).length + 1);
        extra.set(build(strings));
        expect(detect(extra, null).id).not.toBe('loc');
        const wrong = build(strings);
        wrong[4] ^= 0xff;
        expect(detect(wrong, null).id).not.toBe('loc');
        expect(detect(Uint8Array.from([0, 0, 0, 0]), null).id).not.toBe('loc');
    });

    it('pairs each key with its value, including non-ASCII text', () => {
        const parsed = parse(build(strings));
        expect(text(build(strings))).toBe('TEXT_MUSIC_TDR_MUS_RECON\tReCon (Remastered)\nTEXT_MUSIC_RAB_MUS_BIG_FOOT_FKTS\tBig Foot – Tiberian Sons (Bonus)');
        expect(parsed.title).toBe('Petroglyph string table (LOC)');
        expect(parsed.warnings).toEqual([]);
    });

    it('marks out every part of the file', () => {
        const data = build(strings);
        const fields = parse(data).fields;
        expect(fields.map((f) => f.name)).toEqual(['Header', 'Records (2)', 'Values', 'Keys']);
        const last = fields[fields.length - 1];
        expect(last.offset + last.length).toBe(data.length);
        const record = fields[1].children![0];
        expect(record.name).toBe('TEXT_MUSIC_TDR_MUS_RECON');
        expect(record.children!.map((f) => f.value)[1]).toBe('18 characters');
    });

    it('keeps repeated keys, as the credits have', () => {
        const parsed = parse(
            build([
                ['CENTER', 'One'],
                ['CENTER', 'Two'],
            ])
        );
        expect(parsed.summary).toContainEqual(['Strings', '2']);
        expect(parsed.summary).toContainEqual(['Different keys', '1']);
    });

    it('keeps line breaks on one line in the preview', () => {
        expect(text(build([['KEY', 'one\r\ntwo']]))).toBe('KEY\tone\\r\\ntwo');
    });

    it('reads what it can from a damaged file, and says so', () => {
        const cut = build(strings).subarray(0, build(strings).length - 5);
        const parsed = parse(cut);
        expect(parsed.summary).toContainEqual(['Strings', '1']);
        expect(parsed.warnings.join()).toMatch(/past the end/);

        const wrong = build(strings);
        wrong[4] ^= 0xff;
        expect(parse(wrong).warnings.join()).toMatch(/1 key doesn't match/);
    });

    it('refuses a count bigger than the file', () => {
        expect(() => parse(Uint8Array.from([0xff, 0xff, 0xff, 0x7f]))).toThrow(/too big/);
    });
});
