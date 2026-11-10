import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { signature } from './identify';
import { inspect } from './inspect';

const enc = new TextEncoder();
const concat = (...parts: (Uint8Array | number[])[]) => {
    const arrays = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
    const out = new Uint8Array(arrays.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of arrays) (out.set(p, at), (at += p.length));
    return out;
};
const base64 = (data: Uint8Array) => enc.encode(Buffer.from(data).toString('base64'));
const open = (data: Uint8Array, name: string | null, as?: string) => inspect(data, { name, names: [] }, { as });
const levels = (checks: { level: string }[]) => checks.map((c) => c.level);

/** A 1 × 1 GIF89a: two colors, one pixel of color 1. */
const GIF = concat(enc.encode('GIF89a'), [1, 0, 1, 0, 0x80, 0, 0], [0, 0, 0, 255, 255, 255], [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0], [2, 2, 0x4c, 0x01, 0], [0x3b]);

/** The start of a 32-bit Windows program: an MZ header pointing at a PE header. */
function program(): Uint8Array {
    const data = new Uint8Array(512);
    data.set(enc.encode('MZ'), 0);
    data[0x3c] = 0x40;
    data.set(enc.encode('PE\0\0'), 0x40);
    data.set([0x4c, 0x01], 0x44);
    data.set([0x02, 0x01], 0x56);
    for (let i = 0x80; i < data.length; i++) data[i] = (i * 37) & 0xff;
    return data;
}

describe('checks every file gets', () => {
    it('reads a real GIF with nothing to say', async () => {
        const r = await open(GIF, 'ok.gif');
        expect(r.format.id).toBe('gif');
        expect(r.checks).toEqual([]);
    });

    it('calls out a file that starts like a GIF and is named one, but is something else', async () => {
        // Nothing is assumed about what it really is: only that it isn't what it claims.
        const fake = concat(enc.encode('GIF'), new Uint8Array(4000).map((_, i) => 0x41 + ((i * 7) % 26)));
        const r = await open(fake, 'invoice.gif');
        expect(r.format.id).not.toBe('gif');
        expect(r.checks[0].level).toBe('danger');
        expect(r.checks[0].text).toMatch(/named \.gif and starts like a GIF picture \(“GIF”\), but it isn't one: this is Text\. Read as Picture \(GIF\): /);
        expect(r.alternatives.map((f) => f.id)).toContain('gif');
    });

    it('calls out a file named for one format that is another', async () => {
        const r = await open(GIF, 'photo.png');
        expect(r.format.id).toBe('gif');
        expect(r.checks[0]).toMatchObject({ level: 'danger' });
        expect(r.checks[0].text).toMatch(/named \.png, but it isn't Picture \(PNG\): this is Picture \(GIF\)/);
    });

    it('calls out a program under another name', async () => {
        const r = await open(program(), 'readme.txt');
        expect(r.parsed.title).toBe('Windows program (PE, 32-bit)');
        expect(r.checks[0]).toMatchObject({ level: 'danger' });
        expect((await open(program(), 'setup.exe')).checks.map((c) => c.level)).toEqual(['info']);
    });

    it('finds data after the end of a file, and hands it over', async () => {
        const zip = concat(enc.encode('PK\x03\x04'), new Uint8Array(40).fill(7));
        const r = await open(concat(GIF, zip), 'cat.gif');
        expect(r.format.id).toBe('gif');
        expect(r.checks[0].level).toBe('danger');
        expect(r.checks[0].text).toMatch(/44 bytes after the end of the picture \(gif\) \(at offset 35\): ZIP archive/);
        const entry = r.parsed.entries!.find((e) => e.label === 'after the end.zip')!;
        expect(entry.data).toEqual(zip);
        // The GIF parser marks it itself.
        expect(r.parsed.fields.at(-1)).toMatchObject({ name: 'After the trailer', offset: GIF.length, length: zip.length });
    });

    it('lets a little zero padding go, but marks it', async () => {
        const r = await open(concat(GIF, new Uint8Array(3)), 'pad.gif');
        expect(r.checks).toEqual([]);
        expect(r.parsed.fields.at(-1)).toMatchObject({ name: 'After the trailer', length: 3 });
        expect(levels((await open(concat(GIF, new Uint8Array(64)), 'pad.gif')).checks)).toEqual(['info']);
    });

    it('says why a file can\'t be opened as the format asked for, and shows its bytes', async () => {
        const r = await open(enc.encode('not a picture at all'), 'x.bin', 'png');
        expect(r.format.id).toBe('raw');
        expect(r.checks[0].text).toMatch(/can't be read as Picture \(PNG\)/);
    });

    it('knows signatures loosely, so a fake one still counts as a claim', () => {
        expect(signature(enc.encode('GIF and nothing else'))?.format).toBe('gif');
        expect(signature(program())?.name).toBe('Windows program (PE, 32-bit)');
        expect(signature(enc.encode('  <!DOCTYPE html><html>'))?.name).toBe('Web page (HTML)');
    });
});

/**
 * Every sample, as is and disguised: its first 16 bytes, then the rest as
 * base64 (what a fake file looks like). A parser that took the disguised one
 * at face value, with nothing to say, is too trusting.
 */
const SAMPLES = join(__dirname, '../../samples');
/** Files from a real piece of malware (a PHP kit), named and started like pictures, that aren't. */
const DISGUISED = /^loginlock\/images\/.*\.(gif|png)$/;
/** Samples that really aren't what their names say. */
const MISNAMED = ['images/jpeg-not-a-jpeg.jpg', 'westwood/Dune II/DUNE2.ICO'];
function sampleFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? sampleFiles(path) : statSync(path).size < 32e6 ? [path] : [];
    });
}

describe.skipIf(!existsSync(SAMPLES))('samples, real and disguised', () => {
    const files = existsSync(SAMPLES) ? sampleFiles(SAMPLES) : [];
    it.each(files.map((p) => [relative(SAMPLES, p), p]))('%s', async (label, path) => {
        const data = new Uint8Array(readFileSync(path));
        const name = path.split('/').at(-1)!;
        const real = await open(data, name);
        const dangers = real.checks.filter((c) => c.level === 'danger');
        // The malware's "pictures" must be called out; everything else must not be.
        if (DISGUISED.test(label)) expect(dangers.length, label).toBeGreaterThan(0);
        else if (!MISNAMED.includes(label)) expect(dangers).toEqual([]);
        if (real.format.id === 'raw' || real.format.id === 'text' || data.length < 64) return;

        const fake = await open(concat(data.subarray(0, 16), base64(data.subarray(16))), name);
        // Caught: called out, or not taken for the real thing (its parser refused it), or taken for it but with something to say.
        const caught = fake.checks.some((c) => c.level === 'danger') || fake.format.id !== real.format.id || fake.parsed.warnings.length > 0;
        expect(caught, `${label} disguised read as ${fake.format.id}: ${JSON.stringify(fake.checks)}`).toBe(true);
    }, 60_000);
});
