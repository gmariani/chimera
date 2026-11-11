import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { detect } from '../index';
import chunks from './index';

const enc = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
        out.set(p, at);
        at += p.length;
    }
    return out;
}

function pair(a: number, b: number): Uint8Array {
    const out = new Uint8Array(8);
    const view = new DataView(out.buffer);
    view.setUint32(0, a, true);
    view.setUint32(4, b, true);
    return out;
}

const leaf = (id: number, body: Uint8Array) => concat(pair(id, body.length), body);
const container = (id: number, ...children: Uint8Array[]) => concat(pair(id, 0x80000000 + children.length), ...children);
const text = (s: string) => concat(Uint8Array.from([s.length & 0xff, s.length >> 8]), enc.encode(s));
const u32 = (v: number) => {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, v, true);
    return out;
};
const f32 = (...values: number[]) => {
    const out = new Uint8Array(values.length * 4);
    values.forEach((v, i) => new DataView(out.buffer).setFloat32(i * 4, v, true));
    return out;
};
const prop = (tag: number, value: Uint8Array) => concat(Uint8Array.from([tag, value.length]), value);

/** A widget: a chunk 1 of its type (tag 3 of chunk 2) and contents (chunk 4). */
const widget = (type: number, name: string, ...inside: Uint8Array[]) =>
    container(1, leaf(2, prop(3, u32(type))), container(4, container(0, leaf(0, prop(2, f32(0, 0, 1, 1))), leaf(5, text(name))), ...inside));

const layout = concat(
    leaf(1, prop(0, u32(0x0b00))),
    container(
        2,
        container(
            0,
            container(0, leaf(0, prop(2, f32(0, 0, 1, 1))), leaf(5, text('Dialog'))),
            widget(19, 'Group', widget(2, 'Title_Text', container(1, leaf(1, text('TEXT_MUSIC_JUKEBOX_PLAYER')), leaf(2, text('46 Point Outline')))), widget(99, 'Odd'))
        ),
        leaf(3, text('MusicJukeboxDialog'))
    )
);

function wrap(inner: Uint8Array): Uint8Array {
    const zipped = new Uint8Array(deflateSync(inner));
    const header = new Uint8Array(36);
    header.set(enc.encode('CH'));
    header.set([2, 1, 1, 0xff, 0xff, 0xff], 2);
    const view = new DataView(header.buffer);
    view.setUint32(8, 0x75207fd1, true);
    view.setUint32(12, 8, true);
    view.setUint32(16, zipped.length, true);
    return concat(header, zipped);
}

const parse = (data: Uint8Array, name: string | null = null) => chunks.parse(data, { name, names: [] });
const previewText = (data: Uint8Array, name: string | null = null) => {
    const preview = parse(data, name).preview;
    if (preview?.kind !== 'text') throw new Error('Expected a text preview.');
    return preview.text;
};

describe('Petroglyph chunk files', () => {
    it('finds both the compressed file and what it unpacks to', () => {
        expect(detect(wrap(layout), 'X.BUI').id).toBe('chunks');
        expect(detect(wrap(layout), null).id).toBe('chunks');
        expect(detect(layout, null).id).toBe('chunks');
    });

    it("doesn't take files that only look close", () => {
        const trailing = concat(layout, new Uint8Array(3));
        expect(detect(trailing, null).id).not.toBe('chunks');
        expect(detect(new Uint8Array(64), null).id).not.toBe('chunks');
        const badSize = wrap(layout);
        badSize[16] ^= 1;
        expect(detect(badSize, null).id).not.toBe('chunks');
    });

    it('marks out the wrapper, and hands over the uncompressed file', () => {
        const data = wrap(layout);
        const parsed = parse(data, 'DATA\\ART\\GUI\\UI_MUSICJUKEBOX.BUI');
        expect(parsed.fields[0].children!.map((f) => [f.name, f.offset, f.length])).toEqual([
            ['Signature', 0, 2],
            ['Unknown', 2, 6],
            ['Unknown', 8, 4],
            ['Unknown', 12, 4],
            ['Compressed size', 16, 4],
            ['Reserved', 20, 16],
        ]);
        expect(parsed.fields[1].offset + parsed.fields[1].length).toBe(data.length);
        expect(parsed.warnings).toEqual([]);
        const [entry] = parsed.entries!;
        expect(entry.name).toBe('UI_MUSICJUKEBOX.BUI.chunks');
        expect([...entry.data]).toEqual([...layout]);
        expect(detect(entry.data, entry.name).id).toBe('chunks');
    });

    it('outlines a layout: nesting, types, names and text', () => {
        const parsed = parse(wrap(layout));
        expect(parsed.title).toBe('UI layout (Petroglyph)');
        expect(parsed.summary).toContainEqual(['Layout', 'MusicJukeboxDialog']);
        expect(parsed.summary).toContainEqual(['Root', 'Dialog']);
        expect(parsed.summary).toContainEqual(['Widgets', '3']);
        expect(previewText(wrap(layout))).toBe(
            ['MusicJukeboxDialog', 'Root: Dialog', '  Group: Group', '    Text: Title_Text "TEXT_MUSIC_JUKEBOX_PLAYER" "46 Point Outline"', '    Type 99: Odd'].join('\n')
        );
    });

    it('takes a layout with no widgets, and no name chunk, as a layout', () => {
        const empty = concat(
            leaf(1, prop(0, u32(0x0470))),
            container(2, container(0, container(0, leaf(0, prop(2, f32(0, 0, 1, 1))), leaf(5, text('TooltipPlacementScene')))), leaf(4, new Uint8Array(0)))
        );
        const parsed = parse(wrap(empty));
        expect(parsed.title).toBe('UI layout (Petroglyph)');
        expect(parsed.summary).toContainEqual(['Widgets', '0']);
        expect(previewText(wrap(empty))).toBe('Root: TooltipPlacementScene');
    });

    it('lists the strings of a file with no widgets', () => {
        const fonts = container(0, container(0, leaf(0, text('09 Point Drop')), leaf(1, text('Arial'))));
        const parsed = parse(wrap(fonts));
        expect(parsed.title).toBe('Chunk file (Petroglyph)');
        expect(previewText(wrap(fonts))).toBe('09 Point Drop\nArial');
    });

    it('points the unpacked fields at their bytes, showing values as what they look like', () => {
        const parsed = parse(layout);
        expect(parsed.title).toBe('UI layout (Petroglyph)');
        const [first, second] = parsed.fields;
        expect(first).toMatchObject({ name: 'Chunk 1', offset: 0, value: '1 property' });
        expect(first.children![0]).toMatchObject({ name: 'Tag 0', offset: 8, length: 6, value: String(0x0b00) });
        expect(second).toMatchObject({ name: 'Chunk 2', offset: first.length, value: '2 chunks' });
        const group = second.children![0].children![1];
        expect(group.value).toBe('Group: Group');
        const rect = group.children![1].children![0].children![0].children![0];
        expect(rect.value).toBe('0, 0, 1, 1');
        const last = second.children![1];
        expect(last.offset + last.length).toBe(layout.length);
        expect(last.value).toBe('"MusicJukeboxDialog"');
    });

    it('shows other values sensibly', () => {
        const parsed = parse(concat(container(0, leaf(1, prop(1, Uint8Array.from([0xe0, 0x7c, 0x04, 0x21]))), leaf(2, prop(9, f32(0.5)))), leaf(3, new Uint8Array(0))));
        const [c] = parsed.fields;
        expect(c.children![0].children![0].value).toBe('21047CE0');
        expect(c.children![1].children![0].value).toBe('0.5');
        expect(parsed.fields[1].value).toBe('Empty');
    });

    it('says when the data will not unpack, or is not chunks', () => {
        const broken = wrap(layout);
        broken.fill(0xff, 40);
        const damaged = parse(broken);
        expect(damaged.warnings.join()).toMatch(/wouldn't uncompress/);
        expect(damaged.entries).toBeUndefined();

        const notChunks = parse(wrap(enc.encode('This is plain text, not chunks.')));
        expect(notChunks.warnings.join()).toMatch(/isn't a tree of chunks/);
        expect(notChunks.entries).toHaveLength(1);
        expect(notChunks.title).toBe('Compressed chunk file (Petroglyph)');
    });
});
