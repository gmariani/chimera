import { Bytes, bytesLabel, field, hex } from '../../core/bytes';
import type { Field, FormatParser } from '../../core/types';

/**
 * Ogg: a chain of pages, each a 27-byte header, a table of segment lengths and
 * the segments. Segments join into packets (a length under 255 ends one), which
 * can run across pages. Pages of several streams can be mixed, told apart by
 * serial number. A stream's first packets say what's in it: Vorbis, Opus or FLAC
 * sound, which the browser plays; Speex and Theora, which are only described.
 * Those packets also hold the tags, as "KEY=value" text.
 */

/** At most this many pages are listed. */
const MAX_PAGES = 2000;
/** Longest tag value shown. */
const MAX_VALUE = 200;
/** Enough packets to reach every codec's identification and tags. */
const HEADER_PACKETS = 3;

const PLAYABLE = new Set(['Vorbis', 'Opus', 'FLAC']);
const VIDEO = new Set(['Theora']);
const FLAGS: [number, string][] = [
    [1, 'continues a packet'],
    [2, 'first of its stream'],
    [4, 'last of its stream'],
];

/** Ogg's CRC: unlike ZIP's it's unreflected (polynomial 04C11DB7), starts at 0 and isn't inverted at the end. */
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, i) => {
    let r = i << 24;
    for (let bit = 0; bit < 8; bit++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    return r >>> 0;
});

/** A page's CRC, which is taken with the CRC's own four bytes as zero. */
export function pageCrc(data: Uint8Array, offset: number, length: number): number {
    let crc = 0;
    for (let i = 0; i < length; i++) {
        const byte = i >= 22 && i < 26 ? 0 : data[offset + i];
        crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
    }
    return crc;
}

/** A packet's pieces in the file; pages come between them when it spans several. */
type Packet = [offset: number, length: number][];

interface Stream {
    serial: number;
    pages: number;
    bytes: number;
    packets: number;
    lastGranule: number;
    ended: boolean;
    nextSequence: number;
    head: Packet[];
    partial: Packet | null;
}

interface Codec {
    name: string;
    rate: number;
    channels: number;
    /** Bits per sample, for the codecs that keep it. */
    bits: number;
    /** Samples at the start of the stream that aren't played. */
    skip: number;
    tags: [string, string][];
    fields: Field[];
}

/** A file range for part of a packet (a part that spans pages includes the page headers between). */
function place(packet: Packet, at: number, length: number): { offset: number; length: number } {
    let passed = 0;
    let start = -1;
    for (const [offset, size] of packet) {
        if (start < 0 && at < passed + size) start = offset + at - passed;
        if (start >= 0 && at + length <= passed + size) return { offset: start, length: offset + at + length - passed - start };
        passed += size;
    }
    return { offset: start < 0 ? (packet[0]?.[0] ?? 0) : start, length: 0 };
}

function joined(data: Uint8Array, packet: Packet): Uint8Array {
    const out = new Uint8Array(packet.reduce((n, [, size]) => n + size, 0));
    let at = 0;
    for (const [offset, size] of packet) {
        out.set(data.subarray(offset, offset + size), at);
        at += size;
    }
    return out;
}

const latin1 = (bytes: Uint8Array, at: number, length: number) => new TextDecoder('latin1').decode(bytes.subarray(at, at + length));

const isPicture = (key: string) => /^(METADATA_BLOCK_PICTURE|COVERART)$/i.test(key);

/** A Vorbis comment block, as Vorbis, Opus, FLAC, Speex and Theora all store tags: a vendor string, then "KEY=value" strings. */
function comments(data: Uint8Array, packet: Packet, start: number, warnings: string[]): { tags: [string, string][]; fields: Field[] } {
    const bytes = joined(data, packet);
    const b = new Bytes(bytes);
    const utf8 = new TextDecoder();
    const at = (name: string, offset: number, length: number, value?: string | number, note?: string) => {
        const range = place(packet, offset, length);
        return field(name, range.offset, range.length, value, note);
    };
    const tags: [string, string][] = [];
    const fields: Field[] = [];

    const vendorLength = b.u32(start);
    if (start + 4 + vendorLength > bytes.length) {
        warnings.push('The tags run past the end of their packet.');
        return { tags, fields };
    }
    const vendor = utf8.decode(bytes.subarray(start + 4, start + 4 + vendorLength));
    fields.push(at('Vendor', start, 4 + vendorLength, vendor, 'The software that wrote the stream.'));

    const count = b.u32(start + 4 + vendorLength);
    let offset = start + 8 + vendorLength;
    for (let i = 0; i < count; i++) {
        const length = b.u32(offset);
        if (offset + 4 + length > bytes.length) {
            warnings.push('The tags run past the end of their packet.');
            break;
        }
        const text = utf8.decode(bytes.subarray(offset + 4, offset + 4 + length));
        const equals = text.indexOf('=');
        const key = equals < 0 ? text : text.slice(0, equals);
        const value = equals < 0 ? '' : text.slice(equals + 1);
        tags.push([key, value]);
        const shown = isPicture(key) ? `${bytesLabel(value.length)} of Base64 (a picture)` : value.length > MAX_VALUE ? `${value.slice(0, MAX_VALUE)}…` : value;
        fields.push(at(key, offset, 4 + length, shown));
        offset += 4 + length;
    }
    return { tags, fields: [{ ...at('Tags', start, offset - start), value: `${tags.length} tag${tags.length === 1 ? '' : 's'}`, children: fields }] };
}

/** Works out the codec from a stream's first packets. */
function identify(data: Uint8Array, stream: Stream, warnings: string[]): Codec {
    const [first, second, third] = stream.head;
    const bytes = first ? joined(data, first) : new Uint8Array();
    const b = new Bytes(bytes);
    const at = (packet: Packet, name: string, offset: number, length: number, value?: string | number, note?: string) => {
        const range = place(packet, offset, length);
        return field(name, range.offset, range.length, value, note);
    };
    const whole = (packet: Packet | undefined, name: string, value?: string) => {
        if (!packet) return [];
        const size = packet.reduce((n, [, s]) => n + s, 0);
        return [at(packet, name, 0, size, value ?? bytesLabel(size))];
    };
    const tagsFrom = (packet: Packet | undefined, start: number) => (packet ? comments(data, packet, start, warnings) : { tags: [], fields: [] });

    if (bytes[0] === 1 && latin1(bytes, 1, 6) === 'vorbis') {
        const tags = tagsFrom(second, 7);
        const [rate, channels] = [b.u32(12), b.u8(11)];
        const fields = [
            at(first, 'Packet type', 0, 7, '1, "vorbis" (identification)'),
            at(first, 'Vorbis version', 7, 4, b.u32(7)),
            at(first, 'Channels', 11, 1, channels),
            at(first, 'Sample rate', 12, 4, `${rate} Hz`),
            at(first, 'Highest bit rate', 16, 4, bitRate(b.i32(16))),
            at(first, 'Nominal bit rate', 20, 4, bitRate(b.i32(20))),
            at(first, 'Lowest bit rate', 24, 4, bitRate(b.i32(24))),
            at(first, 'Block sizes', 28, 1, `${1 << (b.u8(28) & 15)} and ${1 << (b.u8(28) >> 4)} samples`),
            ...tags.fields,
            ...whole(third, 'Setup', 'The codebooks, read by the decoder.'),
        ];
        return { name: 'Vorbis', rate, channels, bits: 0, skip: 0, tags: tags.tags, fields };
    }
    if (latin1(bytes, 0, 8) === 'OpusHead') {
        const tags = tagsFrom(second, 8);
        const skip = b.u16(10);
        const fields = [
            at(first, 'Signature', 0, 8, 'OpusHead'),
            at(first, 'Version', 8, 1, b.u8(8)),
            at(first, 'Channels', 9, 1, b.u8(9)),
            at(first, 'Pre-skip', 10, 2, `${skip} samples`, "Samples at the start that aren't played."),
            at(first, 'Original sample rate', 12, 4, `${b.u32(12)} Hz`, 'Opus always decodes at 48,000 Hz; this is only what the source was.'),
            at(first, 'Output gain', 16, 2, `${(new DataView(bytes.buffer).getInt16(16, true) / 256).toFixed(2)} dB`),
            at(first, 'Channel mapping', 18, 1, b.u8(18)),
            ...tags.fields,
        ];
        return { name: 'Opus', rate: 48000, channels: b.u8(9), bits: 0, skip, tags: tags.tags, fields };
    }
    if (bytes[0] === 0x7f && latin1(bytes, 1, 4) === 'FLAC') {
        // Past the Ogg mapping's 13 bytes and the block's 4-byte header: 10 bytes of sizes, then 20 bits of rate, 3 of channels, 5 of bits.
        const rate = (b.u8(27) << 12) | (b.u8(28) << 4) | (b.u8(29) >> 4);
        const channels = ((b.u8(29) >> 1) & 7) + 1;
        const bits = (((b.u8(29) & 1) << 4) | (b.u8(30) >> 4)) + 1;
        const tags = second && (joined(data, second)[0] & 0x7f) === 4 ? tagsFrom(second, 4) : { tags: [], fields: [] };
        const fields = [at(first, 'Signature', 0, 5, '7F, "FLAC"'), at(first, 'Mapping version', 5, 2, `${b.u8(5)}.${b.u8(6)}`), at(first, 'Marker', 9, 4, 'fLaC'), at(first, 'Stream information', 13, 38, `${rate} Hz, ${channels} channel${channels === 1 ? '' : 's'}, ${bits}-bit`), ...tags.fields];
        return { name: 'FLAC', rate, channels, bits, skip: 0, tags: tags.tags, fields };
    }
    if (latin1(bytes, 0, 8) === 'Speex   ') {
        const tags = tagsFrom(second, 0);
        const [rate, channels] = [b.u32(36), b.u32(48)];
        return { name: 'Speex', rate, channels, bits: 0, skip: 0, tags: tags.tags, fields: [at(first, 'Signature', 0, 8, 'Speex'), at(first, 'Sample rate', 36, 4, `${rate} Hz`), at(first, 'Channels', 48, 4, channels), ...tags.fields] };
    }
    if (bytes[0] === 0x80 && latin1(bytes, 1, 6) === 'theora') {
        const tags = tagsFrom(second, 7);
        return { name: 'Theora', rate: 0, channels: 0, bits: 0, skip: 0, tags: tags.tags, fields: [at(first, 'Packet type', 0, 7, '80, "theora" (identification)'), ...tags.fields] };
    }
    return { name: 'Unknown', rate: 0, channels: 0, bits: 0, skip: 0, tags: [], fields: whole(first, 'First packet') };
}

function bitRate(value: number): string {
    return value > 0 ? `${(value / 1000).toFixed(0)} kbit/s` : 'Not given';
}

const parser: FormatParser = {
    parse(data) {
        const b = new Bytes(data);
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const isPage = (at: number) => data[at] === 0x4f && data[at + 1] === 0x67 && data[at + 2] === 0x67 && data[at + 3] === 0x53;
        const warnings: string[] = [];
        const streams = new Map<number, Stream>();
        const pageFields: Field[] = [];
        let pages = 0;
        let badCrcs = 0;
        let gaps = 0;
        let at = 0;

        while (at + 27 <= data.length) {
            if (!isPage(at)) {
                let next = at + 1;
                while (next + 27 <= data.length && !isPage(next)) next++;
                if (next + 27 > data.length) break;
                warnings.push(`Bytes ${at} to ${next} aren't an Ogg page.`);
                at = next;
                continue;
            }
            const segments = data[at + 26];
            const headerLength = 27 + segments;
            let bodyLength = 0;
            for (let i = 0; i < segments; i++) bodyLength += b.u8(at + 27 + i);
            if (at + headerLength + bodyLength > data.length) {
                warnings.push(`The page at byte ${at} runs past the end of the file; stopped there.`);
                break;
            }

            const flags = data[at + 5];
            const granule = Number(view.getBigInt64(at + 6, true));
            const [serial, sequence, crc] = [b.u32(at + 14), b.u32(at + 18), b.u32(at + 22)];
            const crcOk = pageCrc(data, at, headerLength + bodyLength) === crc;
            if (!crcOk) badCrcs++;

            let stream = streams.get(serial);
            if (!stream) {
                stream = { serial, pages: 0, bytes: 0, packets: 0, lastGranule: -1, ended: false, nextSequence: sequence, head: [], partial: null };
                streams.set(serial, stream);
            }
            if (sequence !== stream.nextSequence) {
                gaps++;
                stream.partial = null;
            }
            stream.nextSequence = sequence + 1;
            stream.pages++;
            stream.bytes += headerLength + bodyLength;
            if (granule !== -1) stream.lastGranule = granule;
            if (flags & 4) stream.ended = true;

            // Join the segments into packets, keeping where the first few are.
            let bodyAt = at + headerLength;
            let run = 0;
            for (let i = 0; i < segments; i++) {
                const lace = data[at + 27 + i];
                run += lace;
                if (lace === 255 && i < segments - 1) continue;
                const closes = lace < 255;
                if (stream.head.length < HEADER_PACKETS && run > 0) (stream.partial ??= []).push([bodyAt, run]);
                bodyAt += run;
                run = 0;
                if (!closes) break;
                stream.packets++;
                if (stream.head.length < HEADER_PACKETS) stream.head.push(stream.partial ?? []);
                stream.partial = null;
            }

            pages++;
            if (pageFields.length < MAX_PAGES) {
                const named = FLAGS.filter(([bit]) => flags & bit).map(([, name]) => name);
                pageFields.push({
                    name: `Page ${pages}`,
                    offset: at,
                    length: headerLength + bodyLength,
                    value: bytesLabel(bodyLength),
                    children: [
                        field('Signature', at, 4, 'OggS'),
                        field('Version', at + 4, 1, data[at + 4]),
                        field('Flags', at + 5, 1, named.length ? `${flags} (${named.join(', ')})` : flags),
                        field('Granule position', at + 6, 8, granule === -1 ? 'None (no packet ends on this page)' : granule, 'How far the stream has got by this page, in samples for sound.'),
                        field('Serial number', at + 14, 4, hex(serial), 'Which stream the page belongs to.'),
                        field('Sequence number', at + 18, 4, sequence),
                        field('CRC', at + 22, 4, crcOk ? hex(crc) : `${hex(crc)} (wrong)`),
                        field('Segments', at + 26, 1, segments),
                        field('Segment lengths', at + 27, segments),
                        field('Data', at + headerLength, bodyLength, bytesLabel(bodyLength)),
                    ],
                });
            }
            at += headerLength + bodyLength;
        }
        if (!pages) throw new Error('No Ogg pages.');

        const all = [...streams.values()].map((stream) => ({ stream, codec: identify(data, stream, warnings) }));
        const secondsOf = ({ stream, codec }: (typeof all)[number]) => (codec.rate && stream.lastGranule > 0 ? Math.max(0, stream.lastGranule - codec.skip) / codec.rate : 0);
        const sound = all.filter(({ codec }) => codec.rate && !VIDEO.has(codec.name));
        const main = sound[0] ?? all[0];
        const seconds = sound.reduce((n, s) => n + secondsOf(s), 0);

        if (badCrcs) warnings.push(badCrcs === 1 ? '1 page fails its CRC.' : `${badCrcs} pages fail their CRCs.`);
        if (gaps) warnings.push(`Pages are missing in ${gaps} place${gaps === 1 ? '' : 's'}.`);
        if (all.some(({ stream }) => !stream.ended)) warnings.push('A stream has no last page, so the file may be cut short.');
        if (pages > MAX_PAGES) warnings.push(`The first ${MAX_PAGES} of ${pages} pages are listed.`);
        if (at < data.length && at + 27 > data.length) warnings.push(`${data.length - at} bytes are left over after the last page.`);

        const { codec } = main;
        const tagRows = new Map<string, string[]>();
        for (const [key, value] of codec.tags) {
            if (isPicture(key) || !value) continue;
            const name = key.toUpperCase();
            tagRows.set(name, [...(tagRows.get(name) ?? []), value.length > MAX_VALUE ? `${value.slice(0, MAX_VALUE)}…` : value]);
        }
        return {
            title: `${VIDEO.has(codec.name) ? 'Video' : 'Sound'} (Ogg ${codec.name})`,
            summary: [
                ['Codec', codec.name],
                ...(seconds ? ([['Length', `${seconds.toFixed(2)} s`]] as [string, string][]) : []),
                ...(codec.rate ? ([['Sample rate', `${codec.rate} Hz`]] as [string, string][]) : []),
                ...(codec.channels ? ([['Channels', String(codec.channels)]] as [string, string][]) : []),
                ...(seconds ? ([['Bit rate', `${Math.round((data.length * 8) / seconds / 1000)} kbit/s (average)`]] as [string, string][]) : []),
                ...(all.length > 1 ? ([['Streams', all.map((s) => s.codec.name).join(', ')]] as [string, string][]) : []),
                ...[...tagRows].map(([name, values]): [string, string] => [name, values.join('; ')]),
            ],
            fields: [
                ...all.map(({ stream, codec: c }) => ({
                    name: `Stream ${hex(stream.serial)}`,
                    offset: stream.head[0]?.[0]?.[0] ?? 0,
                    length: 0,
                    value: `${c.name}, ${stream.pages} page${stream.pages === 1 ? '' : 's'}, ${stream.packets} packet${stream.packets === 1 ? '' : 's'}`,
                    children: c.fields,
                })),
                { name: 'Pages', offset: 0, length: at, value: `${pages} page${pages === 1 ? '' : 's'}`, children: pageFields },
            ],
            ...(PLAYABLE.has(codec.name) && sound.length ? { preview: { kind: 'audio' as const, wav: data, mime: 'audio/ogg', sampleRate: codec.rate, channels: codec.channels, bits: codec.bits, seconds } } : {}),
            warnings,
        };
    },
};

export default parser;
