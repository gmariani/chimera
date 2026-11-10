import { bytesLabel, field } from '../../core/bytes';
import { inflate } from '../../core/inflate';
import type { Entry, Field, FormatParser, Preview } from '../../core/types';
import { extractAssets, type TagRef } from './assets';
import { SwfReader } from './reader';
import { readTag, TAG_NAMES } from './tags';
import { append } from '../../core/math';

/**
 * Flash movies (SWF 19 spec). An 8-byte header ("FWS", or "CWS" when the rest
 * is zlib-compressed, "ZWS" when LZMA), then the frame size (a RECT), frame
 * rate and count, then tags to the End tag: definitions (shapes, bitmaps,
 * sounds, fonts, sprites), and the control tags that place them frame by
 * frame. Each tag is a 16-bit code and length (10 bits, 6 bits; a length of
 * 63 means a 32-bit length follows).
 */

const parser: FormatParser = {
    parse(data) {
        const signature = String.fromCharCode(data[0], data[1], data[2]);
        if (!['FWS', 'CWS', 'ZWS'].includes(signature)) throw new Error('No SWF signature (FWS, CWS or ZWS).');
        const version = data[3];
        const declared = new DataView(data.buffer, data.byteOffset).getUint32(4, true);
        const warnings: string[] = [];
        const header: Field = {
            name: 'Header',
            offset: 0,
            length: 8,
            children: [
                field('Signature', 0, 3, signature, { FWS: 'Uncompressed.', CWS: 'The rest is zlib-compressed (SWF 6 and later).', ZWS: 'The rest is LZMA-compressed (SWF 13 and later).' }[signature]),
                field('Version', 3, 1, version),
                field('File length', 4, 4, bytesLabel(declared), 'Of the whole file, uncompressed.'),
            ],
        };
        if (signature === 'ZWS') throw new Error('LZMA-compressed SWFs (ZWS) aren\'t read yet.');

        // The movie as an uncompressed SWF: the file itself, or the header with the rest inflated.
        let swf = data;
        if (signature === 'CWS') {
            const body = inflate(data.subarray(8), Math.max(0, declared - 8));
            swf = new Uint8Array(8 + body.length);
            swf.set(data.subarray(0, 8));
            swf[0] = 0x46; // F
            swf.set(body, 8);
            if (swf.length !== declared) warnings.push(`The header says ${bytesLabel(declared)} uncompressed; it inflates to ${bytesLabel(swf.length)}.`);
        } else if (data.length !== declared) {
            warnings.push(`The header says the file is ${bytesLabel(declared)}, but it's ${bytesLabel(data.length)}.`);
        }

        const r = new SwfReader(swf, 8, swf.length, version);
        const size = r.rect('Frame size');
        const rate = swf[r.at + 1] + swf[r.at] / 256;
        r.fixed8('Frame rate', '8.8 fixed point.');
        r.fields[r.fields.length - 1].value = `${rate} fps`;
        const frameCount = r.u16('Frame count');
        const movieHeader: Field = { name: 'Movie header', offset: 8, length: r.at - 8, children: r.fields.splice(0) };

        const refs: TagRef[] = [];
        const counts = new Map<number, number>();
        let background: string | undefined;
        let as3 = false;

        /** Reads tags from `at` to `end`, grouped into the frames they belong to; returns where it stopped. */
        let unknown = 0;
        let ended = false;
        const readTags = (at: number, end: number, sprite: number | null, out: Field[]): number => {
            let frame: Field[] = [];
            let frameStart = at;
            let frames = 0;
            while (at + 2 <= end) {
                const start = at;
                const packed = swf[at] | (swf[at + 1] << 8);
                const code = packed >> 6;
                let length = packed & 0x3f;
                const tagFields: Field[] = [field('Code and length', at, 2, `${code}, ${length === 0x3f ? 'long' : bytesLabel(length)}`, 'Code (high 10 bits), length (low 6; 63: a 32-bit length follows).')];
                at += 2;
                if (length === 0x3f) {
                    length = swf[at] | (swf[at + 1] << 8) | (swf[at + 2] << 16) | (swf[at + 3] << 24);
                    tagFields.push(field('Length', at, 4, bytesLabel(length)));
                    at += 4;
                }
                if (at + length > end) {
                    warnings.push(`Tag ${TAG_NAMES[code] ?? code} at ${start} runs past the end${sprite === null ? '' : ` of sprite ${sprite}`}.`);
                    length = end - at;
                }
                const name = TAG_NAMES[code] ?? `Unknown tag ${code}`;
                if (!TAG_NAMES[code]) unknown++;
                counts.set(code, (counts.get(code) ?? 0) + 1);
                refs.push({ code, at, length, sprite });
                const tr = new SwfReader(swf, at, at + length, version);
                let value: string | undefined;
                try {
                    value =
                        readTag(code, tr, (inner) => {
                            const spriteId = swf[at] | (swf[at + 1] << 8);
                            const nested: Field[] = [];
                            readTags(inner.at, inner.end, spriteId, nested);
                            inner.fields.push({ name: 'Tags', offset: inner.at, length: inner.end - inner.at, children: nested });
                            inner.at = inner.end;
                        }) ?? undefined;
                    if (tr.left > 0) tr.bytes('Unread', undefined, 'Past what the spec defines for this tag.');
                } catch (e) {
                    warnings.push(`${name} at ${start}: ${(e as Error).message}`);
                    if (tr.left > 0) tr.bytes('Data');
                }
                if (code === 9) background = value;
                if (code === 69) as3 = (swf[at] & 0x08) !== 0;
                frame.push({ name, offset: start, length: at + length - start, value, children: [...tagFields, ...tr.fields] });
                at += length;
                if (code === 1) {
                    frames++;
                    out.push({ name: `Frame ${frames}`, offset: frameStart, length: at - frameStart, value: `${frame.length - 1} tag${frame.length === 2 ? '' : 's'}`, children: frame });
                    frame = [];
                    frameStart = at;
                }
                if (code === 0) {
                    if (sprite === null) ended = true;
                    break;
                }
            }
            append(out, frame);
            return at;
        };

        const tags: Field[] = [];
        const end = readTags(r.at, swf.length, null, tags);
        if (!ended) warnings.push('The movie has no End tag, so it may be cut short.');
        if (unknown) warnings.push(`${unknown} tag${unknown === 1 ? ' has a code' : 's have codes'} the SWF spec doesn't define.`);
        const assets = extractAssets(swf, refs, rate);
        warnings.push(...assets.warnings);

        const fields: Field[] =
            signature === 'CWS'
                ? [header, field('Compressed movie', 8, data.length - 8, bytesLabel(data.length - 8), 'zlib. Open "uncompressed.swf" under Contents to see its tags byte by byte.')]
                : [header, movieHeader, ...tags, ...(end < swf.length ? [field('After the End tag', end, swf.length - end, bytesLabel(swf.length - end))] : [])];
        const entries: Entry[] = [...(signature === 'CWS' ? [{ name: null, label: 'uncompressed', offset: 8, size: swf.length, data: swf, meta: { Note: 'The movie, inflated' } }] : []), ...assets.entries];

        const items: { title: string; preview: Preview }[] = assets.texts.map((t) => ({ title: t.title, preview: { kind: 'text', text: t.text } }));
        const total = [...counts.values()].reduce((a, b) => a + b, 0);
        const count = (codes: number[]) => codes.reduce((n, c) => n + (counts.get(c) ?? 0), 0);
        const px = (t: number) => +(t / 20).toFixed(2);
        return {
            title: `Flash movie (SWF ${version}${signature === 'CWS' ? ', compressed' : ''})`,
            summary: [
                ['Stage', `${px(size.xMax - size.xMin)} × ${px(size.yMax - size.yMin)} px`],
                ['Frames', `${frameCount} at ${rate} fps`],
                ...(background ? [['Background', background] as [string, string]] : []),
                ['Scripting', as3 ? 'ActionScript 3' : count([12, 59]) ? 'ActionScript 1/2' : 'None found'],
                ['Tags', `${total}`],
                ['Shapes', String(count([2, 22, 32, 83, 46, 84]))],
                ['Bitmaps', String(count([6, 20, 21, 35, 36, 90]))],
                ['Sounds', `${count([14])}${count([18, 45]) ? ` and ${count([18, 45])} stream${count([18, 45]) === 1 ? '' : 's'}` : ''}`],
                ['Fonts', String(count([10, 48, 75, 91]))],
                ...(count([24, 58, 64]) ? [['Protection', [counts.get(24) && 'Protected from import', count([58, 64]) && 'Debugging enabled'].filter(Boolean).join(', ')] as [string, string]] : []),
                ...([253, 255, 264, 1002, 1022].some((c) => counts.has(c)) ? [['Obfuscated', 'Yes: it has an obfuscator\'s tags'] as [string, string]] : []),
            ],
            fields,
            entries: entries.length ? entries : undefined,
            preview: items.length === 1 ? items[0].preview : items.length ? { kind: 'stack', items } : undefined,
            // In a compressed movie the bytes after the End tag are in the uncompressed one, which gets its own checks.
            end: signature === 'CWS' ? undefined : end,
            warnings,
        };
    },
};

export default parser;
