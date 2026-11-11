import { describe, expect, it } from 'vitest';
import { detect } from '../index';
import ogg, { pageCrc } from './index';

const enc = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) (out.set(p, at), (at += p.length));
    return out;
}

function le32(value: number): Uint8Array {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value, true);
    return out;
}

interface PageSpec {
    flags?: number;
    granule?: number;
    serial?: number;
    sequence: number;
    /** Each is a whole segment run; `open` leaves the last one unfinished, to go on in the next page. */
    packets: Uint8Array[];
    open?: boolean;
}

function page({ flags = 0, granule = 0, serial = 1, sequence, packets, open }: PageSpec): Uint8Array {
    const lacing: number[] = [];
    packets.forEach((packet, i) => {
        let left = packet.length;
        while (left >= 255) (lacing.push(255), (left -= 255));
        if (!(open && i === packets.length - 1)) lacing.push(left);
    });
    const header = new Uint8Array(27 + lacing.length);
    header.set(enc.encode('OggS'));
    header[5] = flags;
    const view = new DataView(header.buffer);
    view.setBigInt64(6, BigInt(granule), true);
    view.setUint32(14, serial, true);
    view.setUint32(18, sequence, true);
    header[26] = lacing.length;
    header.set(lacing, 27);
    const out = concat(header, ...packets);
    view.setUint32(22, pageCrc(out, 0, out.length), true);
    out.set(header.subarray(22, 26), 22);
    return out;
}

function vorbisIdent(rate: number, channels: number): Uint8Array {
    const out = new Uint8Array(30);
    out[0] = 1;
    out.set(enc.encode('vorbis'), 1);
    out[11] = channels;
    const view = new DataView(out.buffer);
    view.setUint32(12, rate, true);
    view.setInt32(20, 128000, true);
    out[28] = 0xb8;
    out[29] = 1;
    return out;
}

function commentBlock(tags: string[]): Uint8Array {
    const vendor = enc.encode('test vendor');
    return concat(le32(vendor.length), vendor, le32(tags.length), ...tags.flatMap((t) => [le32(enc.encode(t).length), enc.encode(t)]));
}

const vorbisComment = (tags: string[]) => concat(Uint8Array.from([3]), enc.encode('vorbis'), commentBlock(tags));

function vorbisFile(tags: string[], { rate = 44100, channels = 2, granule = 88200 } = {}): Uint8Array {
    return concat(
        page({ flags: 2, sequence: 0, packets: [vorbisIdent(rate, channels)] }),
        page({ sequence: 1, granule: -1, packets: [vorbisComment(tags), concat(Uint8Array.from([5]), enc.encode('vorbis'))] }),
        page({ flags: 4, sequence: 2, granule, packets: [new Uint8Array(10)] })
    );
}

const parse = (data: Uint8Array) => ogg.parse(data, { name: null, names: [] });
const summary = (data: Uint8Array) => Object.fromEntries(parse(data).summary);

describe('Ogg', () => {
    it('computes the same page CRC as a real encoder', () => {
        // The first page of a Vorbis file written by FFmpeg, as is.
        const real = Uint8Array.from(
            '4f67675300020000000000000000d43ae91a00000000ee3c08ff011e01766f72626973000000000122560000000000001e9d000000000000a901'.match(/../g)!.map((pair) => parseInt(pair, 16))
        );
        expect(real.length).toBe(58);
        expect(pageCrc(real, 0, real.length)).toBe(new DataView(real.buffer).getUint32(22, true));
    });

    it('is found by its signature, whatever the name', () => {
        expect(detect(vorbisFile([]), 'x.ogg').id).toBe('ogg');
        expect(detect(vorbisFile([]), null).id).toBe('ogg');
        expect(detect(new Uint8Array(40), 'x.bin').id).not.toBe('ogg');
    });

    it('reads Vorbis: rate, channels, length and tags', () => {
        const data = vorbisFile(['TITLE=Hell March (Remastered)', 'ARTIST=Frank Klepacki', 'artist=Someone Else', 'TITLE2=Ünï']);
        const parsed = parse(data);
        expect(parsed.title).toBe('Sound (Ogg Vorbis)');
        const rows = Object.fromEntries(parsed.summary);
        expect(rows).toMatchObject({
            Codec: 'Vorbis',
            Length: '2.00 s',
            'Sample rate': '44100 Hz',
            Channels: '2',
            TITLE: 'Hell March (Remastered)',
            ARTIST: 'Frank Klepacki; Someone Else',
            TITLE2: 'Ünï',
        });
        expect(parsed.warnings).toEqual([]);
        expect(parsed.preview).toMatchObject({ kind: 'audio', mime: 'audio/ogg', sampleRate: 44100, channels: 2, seconds: 2 });
    });

    it('rejoins tags spanning pages, and marks the file ranges they came from', () => {
        const long = `COMMENT=${'x'.repeat(600)}`;
        const packet = vorbisComment(['TITLE=Span', long]);
        const [a, c] = [packet.subarray(0, 510), packet.subarray(510)];
        const data = concat(
            page({ flags: 2, sequence: 0, packets: [vorbisIdent(44100, 2)] }),
            page({ sequence: 1, granule: -1, packets: [a], open: true }),
            page({ flags: 5, sequence: 2, granule: 44100, packets: [c] })
        );
        const parsed = parse(data);
        expect(parsed.warnings).toEqual([]);
        expect(Object.fromEntries(parsed.summary).TITLE).toBe('Span');
        const tags = parsed.fields[0].children!.find((f) => f.name === 'Tags')!;
        const title = tags.children!.find((f) => f.name === 'TITLE')!;
        expect(new TextDecoder().decode(data.subarray(title.offset + 4, title.offset + title.length))).toBe('TITLE=Span');
    });

    it('describes a picture tag instead of showing it', () => {
        const parsed = parse(vorbisFile(['METADATA_BLOCK_PICTURE=AAAA']));
        expect(Object.keys(Object.fromEntries(parsed.summary))).not.toContain('METADATA_BLOCK_PICTURE');
        expect(parsed.fields[0].children!.find((f) => f.name === 'Tags')!.children!.at(-1)!.value).toMatch(/Base64/);
    });

    it('reads Opus, taking the pre-skip off the length', () => {
        const head = new Uint8Array(19);
        head.set(enc.encode('OpusHead'));
        head[8] = 1;
        head[9] = 2;
        new DataView(head.buffer).setUint16(10, 312, true);
        new DataView(head.buffer).setUint32(12, 44100, true);
        const data = concat(
            page({ flags: 2, sequence: 0, packets: [head] }),
            page({ sequence: 1, granule: -1, packets: [concat(enc.encode('OpusTags'), commentBlock(['TITLE=Op']))] }),
            page({ flags: 4, sequence: 2, granule: 48312, packets: [new Uint8Array(4)] })
        );
        expect(summary(data)).toMatchObject({ Codec: 'Opus', 'Sample rate': '48000 Hz', Length: '1.00 s', TITLE: 'Op' });
    });

    it('reads FLAC in Ogg: rate, channels and bits from the packed fields', () => {
        const head = new Uint8Array(51);
        head[0] = 0x7f;
        head.set(enc.encode('FLAC'), 1);
        head[5] = 1;
        head.set(enc.encode('fLaC'), 9);
        // 44100 Hz (0x0AC44), 2 channels (1), 16 bits (15).
        head.set([0x0a, 0xc4, 0x42, 0xf0], 27);
        const comment = concat(Uint8Array.from([4, 0, 0, 0]), commentBlock(['TITLE=Fl']));
        const data = concat(
            page({ flags: 2, sequence: 0, packets: [head] }),
            page({ sequence: 1, granule: -1, packets: [comment] }),
            page({ flags: 4, sequence: 2, granule: 44100, packets: [new Uint8Array(4)] })
        );
        expect(summary(data)).toMatchObject({ Codec: 'FLAC', 'Sample rate': '44100 Hz', Channels: '2', Length: '1.00 s', TITLE: 'Fl' });
        expect(parse(data).preview).toMatchObject({ kind: 'audio', bits: 16 });
    });

    it('describes video without offering a player', () => {
        const parsed = parse(
            concat(page({ flags: 2, sequence: 0, packets: [concat(Uint8Array.from([0x80]), enc.encode('theora'), new Uint8Array(30))] }), page({ flags: 4, sequence: 1, packets: [new Uint8Array(4)] }))
        );
        expect(parsed.title).toBe('Video (Ogg Theora)');
        expect(parsed.preview).toBeUndefined();
    });

    it('lists every stream, and goes by the sound when there is video too', () => {
        const data = concat(
            page({ flags: 2, serial: 7, sequence: 0, packets: [concat(Uint8Array.from([0x80]), enc.encode('theora'), new Uint8Array(30))] }),
            page({ flags: 2, serial: 9, sequence: 0, packets: [vorbisIdent(22050, 1)] }),
            page({ flags: 4, serial: 7, sequence: 1, granule: 100, packets: [new Uint8Array(4)] }),
            page({ flags: 4, serial: 9, sequence: 1, granule: 22050, packets: [new Uint8Array(4)] })
        );
        expect(summary(data)).toMatchObject({ Codec: 'Vorbis', Streams: 'Theora, Vorbis', Length: '1.00 s' });
    });

    it('says when a page is damaged, missing or cut off', () => {
        const flipped = vorbisFile(['TITLE=A']);
        flipped[flipped.length - 1] ^= 1;
        expect(parse(flipped).warnings.join()).toMatch(/1 page fails its CRC/);

        const missing = concat(page({ flags: 2, sequence: 0, packets: [vorbisIdent(44100, 2)] }), page({ flags: 4, sequence: 5, granule: 44100, packets: [new Uint8Array(4)] }));
        expect(parse(missing).warnings.join()).toMatch(/missing in 1 place/);

        const whole = vorbisFile(['TITLE=A']);
        const warnings = parse(whole.subarray(0, whole.length - 3)).warnings.join();
        expect(warnings).toMatch(/runs past the end/);
        expect(warnings).toMatch(/may be cut short/);
    });

    it('skips junk between pages', () => {
        const first = page({ flags: 2, sequence: 0, packets: [vorbisIdent(44100, 2)] });
        const data = concat(first, new Uint8Array(5), page({ flags: 4, sequence: 1, granule: 44100, packets: [new Uint8Array(40)] }));
        const parsed = parse(data);
        expect(parsed.warnings.join()).toMatch(/aren't an Ogg page/);
        expect(Object.fromEntries(parsed.summary).Length).toBe('1.00 s');
    });

    it('refuses a file with no pages', () => {
        expect(() => parse(new Uint8Array(64))).toThrow(/No Ogg pages/);
    });
});
