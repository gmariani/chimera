import { describe, expect, it } from 'vitest';
import { Engine, Stopped, type Transport } from './client';
import type { FromPage, FromWorker } from './protocol';
import { serve } from './serve';

const enc = new TextEncoder();
const concat = (...parts: (Uint8Array | number[])[]) => {
    const arrays = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
    const out = new Uint8Array(arrays.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of arrays) {
        out.set(p, at);
        at += p.length;
    }
    return out;
};

/** A 1 × 1 GIF89a with two colors and `frames` frames of 10 hundredths each. */
function gif(frames: number): Uint8Array {
    const frame = concat([0x21, 0xf9, 4, 0, 10, 0, 0, 0], [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0], [2, 2, 0x4c, 0x01, 0]);
    return concat(enc.encode('GIF89a'), [1, 0, 1, 0, 0x80, 0, 0], [0, 0, 0, 255, 255, 255], ...Array.from({ length: frames }, () => frame), [0x3b]);
}

/** The worker, in this thread: messages are cloned both ways, as postMessage does. */
function local(log: FromPage[] = [], hangOn?: FromPage['request']['op']): () => Transport {
    return () => {
        let dead = false;
        const t: Transport = { onmessage: null, onerror: null, post: () => {}, terminate: () => void (dead = true) };
        const handle = serve((m: FromWorker) => {
            if (!dead) queueMicrotask(() => !dead && t.onmessage?.(structuredClone(m)));
        });
        t.post = (m) => {
            log.push(m);
            if (m.request.op === hangOn) {
                // Starts, and never says another word: a parse stuck in a loop.
                queueMicrotask(() => t.onmessage?.({ id: m.id, type: 'start' }));
                return;
            }
            handle(structuredClone(m));
        };
        return t;
    };
}

describe('the parsing engine', () => {
    it('reads a file in the worker and brings back what the page shows', async () => {
        const engine = new Engine(local());
        const r = await engine.inspect(gif(1), { name: 'a.gif', shownName: 'a.gif' });
        expect(r.format.id).toBe('gif');
        expect(r.checks).toEqual([]);
        expect(r.parsed.preview?.kind).toBe('picture');
        expect(r.parsed.fields.map((f) => f.name)).toContain('Header');
    });

    it('decodes video frames on demand, through the worker', async () => {
        const engine = new Engine(local());
        const r = await engine.inspect(gif(3), { name: 'a.gif', shownName: 'a.gif' });
        const p = r.parsed.preview!;
        if (p.kind !== 'video') throw new Error(p.kind);
        const f = await p.frame(2);
        expect('rgba' in f && [...f.rgba]).toEqual([255, 255, 255, 255]);
    });

    it('sends bytes once, and files inside as places in them', async () => {
        const log: FromPage[] = [];
        const engine = new Engine(local(log));
        const zip = concat(enc.encode('PK\x03\x04'), new Uint8Array(40).fill(7));
        const data = concat(gif(1), zip);
        const r = await engine.inspect(data, { name: 'a.gif', shownName: 'a.gif' });
        const after = r.parsed.entries!.find((e) => e.label.startsWith('after the end'))!;
        expect(after.data).toEqual(zip);
        // A view of the page's own bytes, not a copy.
        expect(after.data.buffer).toBe(data.buffer);
        await engine.inspect(after.data, { name: null, shownName: 'after the end.zip' });
        await engine.inspect(data, { name: 'a.gif', shownName: 'a.gif' });
        const refs = log.filter((m) => m.request.op === 'inspect').map((m) => (m.request as { data: object }).data);
        expect('data' in refs[0]).toBe(true);
        expect('parent' in refs[1] && !('data' in refs[1])).toBe(true);
        expect(Object.keys(refs[2])).toEqual(['key']);
    });

    it("stops a read that hangs, says so, and won't read it that way again", async () => {
        const log: FromPage[] = [];
        const engine = new Engine(local(log, 'inspect'), 200);
        const added = await engine.add('a.gif', gif(1), 'added');
        expect(added.file?.id).toBe('a.gif');
        const events: string[] = [];
        engine.on((e) => events.push(e.kind));
        const data = gif(2);
        await expect(engine.inspect(data, { name: 'b.gif', shownName: 'b.gif' })).rejects.toThrow(Stopped);
        expect(events).toEqual(['stopped', 'restarted']);
        // The new worker got the session's file back.
        expect(log.filter((m) => m.request.op === 'add')).toHaveLength(2);
        // And the file that hung is refused at once, without going to the worker.
        const before = log.length;
        await expect(engine.inspect(data, { name: 'b.gif', shownName: 'b.gif' })).rejects.toThrow(/more than 0 seconds|without finishing/);
        expect(log.length).toBe(before);
    }, 10_000);

    it('blames the oldest request when the worker hangs before saying it started', async () => {
        // Stuck before a word: the worker is frozen as the request arrives.
        const silent = () => {
            const t: Transport = { onmessage: null, onerror: null, post: () => {}, terminate: () => {} };
            return t;
        };
        let first = true;
        const engine = new Engine(() => (first ? ((first = false), silent()) : local()()), 200);
        const data = gif(1);
        await expect(engine.inspect(data, { name: 'a.gif', shownName: 'a.gif' })).rejects.toThrow(Stopped);
        // The worker after it reads other files.
        expect((await engine.inspect(gif(2), { name: 'b.gif', shownName: 'b.gif' })).format.id).toBe('gif');
    }, 10_000);

    it('lets the user stop what the worker is on', async () => {
        const engine = new Engine(local([], 'inspect'));
        const read = engine.inspect(gif(1), { name: 'a.gif', shownName: 'a.gif' });
        await new Promise((r) => setTimeout(r, 20));
        expect(engine.busy).toBe(true);
        engine.stop('Stopped by you.');
        await expect(read).rejects.toThrow(/Stopped by you/);
    });
});
