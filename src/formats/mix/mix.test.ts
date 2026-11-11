import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Blowfish } from './blowfish';
import { classicId, crcId } from './ids';
import { blowfishKey } from './key';
import { parseMix, readLayout, unlistedRanges } from './index';
import { sha1 } from '../../core/sha1';
import { sniffMix } from './sniff';

const fromHex = (text: string) => Uint8Array.from(text.match(/../g)!, (b) => parseInt(b, 16));
const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

// Expected values come from the C++ code in the MIX format document, compiled as-is.
describe('file IDs', () => {
    const vectors: [string, number, number][] = [
        ['local mix database.dat', 0x54c2d545, 0x366e051f],
        ['conquer.mix', 0xa2361104, 0x55de03cc],
        ['a', 0x00000041, 0xeb978531],
        ['ab', 0x00004241, 0x421faa6e],
        ['abc', 0x00434241, 0x33aff496],
        ['abcd', 0x44434241, 0xdb1720a5],
        ['abcde', 0x888684c7, 0x518e3366],
        ['rules.ini', 0xb1c3b238, 0xf025a96c],
        ['E1.SHP', 0xa65cb2d2, 0x30739919],
        ['temperat.pal', 0x35f90a09, 0x9c58de40],
    ];
    it.each(vectors)('%s', (name, classic, crc) => {
        expect(classicId(name)).toBe(classic);
        expect(crcId(name)).toBe(crc);
    });
});

describe('blowfish', () => {
    it('matches the standard all-zero test vector', () => {
        expect(toHex(new Blowfish(new Uint8Array(8)).encrypt(new Uint8Array(8)))).toBe('4ef997456198dd78');
    });

    it('decrypts what it encrypts', () => {
        const bf = new Blowfish(fromHex('0123456789abcdeffedcba9876543210'));
        const plain = Uint8Array.from({ length: 64 }, (_, i) => i * 7);
        expect(bf.decrypt(bf.encrypt(plain))).toEqual(plain);
    });
});

describe('key calculation', () => {
    const vectors = [
        {
            source: '072c51769bc0e50a2f54799ec3e80d32577ca1c6eb10355a7fa4c9ee13385d82a7ccf1163b6085aacff4193e6388add2f71c41668bb0d5fa1f44698eb3d8fd22476c91b6db00254a6f94b9de03284d72',
            key: '51295b2b8881dbda8b44b841aa802c2c53643167fd1c386f9429a23a434053e87854bf696f9a028e5cd093c2676ee9cb22ba9474d3324312',
            cipher: '30da5eb04fd9a8115cd0c01ec34dea77',
        },
        {
            source: '6c91b6db00254a6f94b9de03284d7297bce1062b50759abfe4092e53789dc2e70c31567ba0c5ea0f34597ea3c8ed12375c81a6cbf0153a5f84a9cef3183d6287acd1f61b40658aafd4f91e43688db2d7',
            key: 'b3ac519ff5f1957e2d74b3a1f27ee5742fa6a3bc80f09ca4f6ff8d48d53e8e7b4b038a4df1e7e7b931ed3689f2a90d1516bbbb8544c686ca',
            cipher: 'a5a39113f12247e350989cefe399edc6',
        },
        {
            source: 'd1f61b40658aafd4f91e43688db2d7fc21466b90b5daff24496e93b8dd02274c7196bbe0052a4f7499bee3082d52779cc1e60b30557a9fc4e90e33587da2c7ec11365b80a5caef14395e83a8cdf2173c',
            key: '7bcfc2df018014f96cbdf13639849be3a34924459a7eb3fb8cf28784ea4580d85ba18281cafb06725c76b913b025f0204095431d8d260a37',
            cipher: '5da247b6116496b9567af4490e5f6d99',
        },
    ];
    it.each(vectors)('derives the key and encrypts like the reference ($key)', ({ source, key, cipher }) => {
        const derived = blowfishKey(fromHex(source));
        expect(toHex(derived)).toBe(key);
        expect(toHex(new Blowfish(derived).encrypt(Uint8Array.from({ length: 16 }, (_, i) => i)))).toBe(cipher);
    });
});

/** Builds a MIX file the way the games lay one out. */
function buildMix(files: [string, Uint8Array][], options: { layout: 'td' | 'ra'; encrypt?: boolean; checksum?: boolean; badChecksum?: boolean; hidden?: Uint8Array; bodySize?: number }) {
    const index = files.map(([name, data]) => ({ id: classicId(name), data })).sort((a, b) => (a.id | 0) - (b.id | 0));
    // Bytes no entry points to, stored before the files.
    const hidden = options.hidden ?? new Uint8Array();
    const bodySize = options.bodySize ?? hidden.length + index.reduce((n, f) => n + f.data.length, 0);
    const header = new Uint8Array(6 + index.length * 12);
    const view = new DataView(header.buffer);
    view.setUint16(0, index.length, true);
    view.setUint32(2, bodySize, true);
    let offset = hidden.length;
    index.forEach((f, i) => {
        view.setUint32(6 + i * 12, f.id, true);
        view.setUint32(10 + i * 12, offset, true);
        view.setUint32(14 + i * 12, f.data.length, true);
        offset += f.data.length;
    });
    const parts: Uint8Array[] = [];
    if (options.layout === 'ra') {
        const flags = new Uint8Array(4);
        new DataView(flags.buffer).setUint32(0, (options.encrypt ? 0x20000 : 0) | (options.checksum ? 0x10000 : 0), true);
        parts.push(flags);
    }
    if (options.encrypt) {
        const source = Uint8Array.from({ length: 80 }, (_, i) => (i * 13 + 5) & 0xff);
        const padded = new Uint8Array(Math.ceil(header.length / 8) * 8);
        padded.set(header);
        parts.push(source, new Blowfish(blowfishKey(source)).encrypt(padded));
    } else {
        parts.push(header);
    }
    const body = [hidden, ...index.map((f) => f.data)];
    parts.push(...body);
    if (options.checksum) {
        const digest = createHash('sha1');
        for (const part of body) digest.update(part);
        const sum = new Uint8Array(digest.digest());
        if (options.badChecksum) sum[0] ^= 1;
        parts.push(sum);
    }
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
        out.set(p, at);
        at += p.length;
    }
    return out;
}

describe('MIX parsing', () => {
    const files: [string, Uint8Array][] = [
        ['rules.ini', new TextEncoder().encode('[General]\nName=Test\n')],
        ['temperat.pal', new Uint8Array(768).fill(9)],
        ['mystery.bin', Uint8Array.of(1, 2, 3)],
    ];

    for (const options of [{ layout: 'td' as const }, { layout: 'ra' as const }, { layout: 'ra' as const, checksum: true }, { layout: 'ra' as const, encrypt: true }]) {
        it(`reads ${JSON.stringify(options)}`, () => {
            const data = buildMix(files, options);
            expect(sniffMix(data)).toBe(true);
            const parsed = parseMix(data, { name: null, names: ['mystery.bin'] });
            expect(parsed.warnings).toEqual([]);
            expect(parsed.entries).toHaveLength(3);
            for (const [name, content] of files) {
                const entry = parsed.entries!.find((e) => e.name === name);
                expect(entry?.data).toEqual(content);
            }
            if (options.encrypt) expect(parsed.overlays).toHaveLength(1);
        });
    }

    it('checks the checksum against the body', () => {
        const good = parseMix(buildMix(files, { layout: 'ra', checksum: true }), { name: null, names: [] });
        expect(good.summary).toContainEqual(['Checksum', 'SHA-1, matches']);
        expect(good.fields.at(-1)!.note).toMatch(/Matches the body/);

        const bad = parseMix(buildMix(files, { layout: 'ra', checksum: true, badChecksum: true }), { name: null, names: [] });
        expect(bad.summary).toContainEqual(['Checksum', "SHA-1, doesn't match"]);
        expect(bad.warnings.join()).toMatch(/checksum doesn't match/);
    });

    it('opens the bytes no entry points to, and counts zeros as padding', () => {
        const hidden = new TextEncoder().encode('; Scenario 8 control for house BadGuy.');
        const data = buildMix(files, { layout: 'ra', checksum: true, hidden });
        const parsed = parseMix(data, { name: null, names: [] });
        expect(parsed.warnings).toEqual([]);
        expect(parsed.entries).toHaveLength(4);
        const extra = parsed.entries![3];
        expect(extra).toMatchObject({ name: null, label: `unlisted at ${4 + 6 + 3 * 12}`, size: hidden.length });
        expect(extra.data).toEqual(hidden);
        expect(parsed.summary.find(([k]) => k === 'Unlisted data')![1]).toMatch(/in 1 place/);
        expect(parsed.summary).toContainEqual(['Checksum', 'SHA-1, matches']);
        const body = parsed.fields.find((f) => f.name === 'Body')!;
        expect(body.children![0]).toMatchObject({ name: 'Unlisted data', offset: extra.offset, length: hidden.length });

        const zeros = parseMix(buildMix(files, { layout: 'td', hidden: new Uint8Array(5) }), { name: null, names: [] });
        expect(zeros.entries).toHaveLength(3);
        expect(zeros.summary).toContainEqual(['Padding', '5 bytes between files (zeros, or leftovers before a file on a 16-byte boundary)']);
    });

    it('takes a few leftover bytes before a boundary as padding, as TS and RA2 leave them', () => {
        const scraps = new TextEncoder().encode('ransp');
        // Before a file at body offset 5: not a boundary, so it's data.
        expect(parseMix(buildMix(files, { layout: 'ra', hidden: scraps }), { name: null, names: [] }).entries).toHaveLength(4);
        // At the end of the body: padding.
        const atEnd = parseMix(buildMix([], { layout: 'ra', hidden: scraps }), { name: null, names: [] });
        expect(atEnd.entries).toHaveLength(0);
        expect(atEnd.summary.find(([k]) => k === 'Padding')).toBeTruthy();
    });

    it('finds the gaps between, before and after entries, ignoring overlaps', () => {
        expect(
            unlistedRanges(
                [
                    { id: 1, offset: 4, size: 4 },
                    { id: 2, offset: 6, size: 4 },
                    { id: 3, offset: 14, size: 2 },
                ],
                20
            )
        ).toEqual([
            { offset: 0, length: 4 },
            { offset: 10, length: 4 },
            { offset: 16, length: 4 },
        ]);
        expect(unlistedRanges([{ id: 1, offset: 0, size: 30 }], 20)).toEqual([]);
    });

    it('says when the body size looks raised on purpose', () => {
        const data = buildMix(files, { layout: 'ra', bodySize: 99999 });
        const parsed = parseMix(data, { name: 'x.mix', names: [] });
        expect(parsed.warnings.join()).toMatch(/XCC Mixer refuses/);
        expect(parsed.entries).toHaveLength(3);
    });

    it('hashes like the reference SHA-1', () => {
        expect(toHex(sha1(new TextEncoder().encode('abc')))).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
        expect(toHex(sha1(new Uint8Array()))).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
    });

    it('rejects things that are not MIX files', () => {
        expect(sniffMix(new TextEncoder().encode('Hello, world! This is just text.'))).toBe(false);
        expect(() => readLayout(Uint8Array.of(0xff, 0xff, 0, 0, 0, 0, 0, 0))).toThrow();
    });
});

// Real game files, if present (they aren't committed).
const samples = join(__dirname, '../../../samples/westwood');
describe.skipIf(!existsSync(samples))('sample files', () => {
    const names = existsSync(samples) ? readdirSync(samples).filter((n) => /\.mix$/i.test(n)) : [];
    it.each(names)('%s', (name) => {
        const data = new Uint8Array(readFileSync(join(samples, name)));
        expect(sniffMix(data)).toBe(true);
        const parsed = parseMix(data, { name, names: [] });
        expect(parsed.warnings).toEqual([]);
        // Every entry lies inside the body.
        for (const entry of parsed.entries!) expect(entry.data.length).toBe(entry.size);
        console.log(name, parsed.summary.map(([k, v]) => `${k}: ${v}`).join(' | '));
    });
});
