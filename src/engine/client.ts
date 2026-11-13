import type { Entry, FormatDescriptor, IndexedImage, Parsed, Preview, VideoFrame } from '../core/types';
import { FORMATS, RAW } from '../formats';
import type { Check } from '../formats/inspect';
import type { NamedPalette } from '../lib/palettes';
import type { SessionFile } from './library';
import type { DataRef, FromPage, FromWorker, Request, Results, WireEntry, WireInspection, WirePreview } from './protocol';

/**
 * The page's side of the parsing worker. Every request goes to the worker; a
 * watchdog stops the worker when it goes quiet for too long in the middle of
 * one (a file made to hang a parser, or one too big for the machine), starts
 * another, and puts the session's files back into it. The request that hung
 * fails with Stopped, and the same file isn't read that way again, so it
 * can't hang the page in a loop; the others carry on in the new worker.
 */

/** Seconds the worker may go without a word while it's working before it's taken to be stuck. */
export const HANG_LIMIT = 30;

/** Reading something was stopped: it hung, the worker died, or the user stopped it. */
export class Stopped extends Error {
    override name = 'Stopped';
}

/** How the page talks to a worker: a real one, or (in tests) one in the same thread. */
export interface Transport {
    post(message: FromPage): void;
    terminate(): void;
    onmessage: ((message: FromWorker) => void) | null;
    /** The worker died on its own. */
    onerror: ((message: string) => void) | null;
}

/** A preview, with what it decodes on demand coming from the worker (so it's asynchronous). */
export type UiPreview =
    | Exclude<Preview, { kind: 'images' | 'picture' | 'video' | 'stack' }>
    | (Omit<Extract<Preview, { kind: 'images' }>, 'toggle'> & { toggle?: { label: string; off(): Promise<IndexedImage[]> } })
    | (Omit<Extract<Preview, { kind: 'picture' }>, 'toggle'> & { toggle?: { label: string; off(): Promise<Uint8Array> } })
    | (Omit<Extract<Preview, { kind: 'video' }>, 'frame'> & { frame(index: number, playing?: boolean): Promise<VideoFrame> })
    | { kind: 'stack'; items: { title: string; preview: UiPreview }[] };

export type UiParsed = Omit<Parsed, 'preview'> & { preview?: UiPreview };

export interface UiInspection {
    format: FormatDescriptor;
    /** It uses other files, so it's worth reading again when there are more. */
    companions: boolean;
    parsed: UiParsed;
    /** The format each entry was detected as, by id. */
    entryFormats: string[];
    checks: Check[];
    alternatives: FormatDescriptor[];
}

export type EngineEvent = { kind: 'stopped'; op: Request['op']; what: string; reason: string } | { kind: 'restarted'; generation: number };

interface Pending {
    /** Builds the request (again, after a restart: the new worker knows no keys). */
    build(): Request;
    what: string;
    /** What the request reads, so it isn't read the same way after it hung. */
    poison?: string;
    resolve(value: unknown): void;
    reject(error: Error): void;
}

const formatOf = (id: string) => FORMATS.find((f) => f.id === id) ?? RAW;
const whole = (data: Uint8Array) => data.byteOffset === 0 && data.byteLength === data.buffer.byteLength;

export class Engine {
    private transport: Transport | null = null;
    /** Bumped each time a new worker starts: handles and keys from an older one mean nothing to it. */
    generation = 0;
    private nextId = 1;
    private nextKey = 1;
    private readonly pending = new Map<number, Pending>();
    /** When the worker last said anything. */
    private lastSign = 0;
    /** The request the worker is on. */
    private current: number | null = null;
    private watchdog: ReturnType<typeof setInterval> | null = null;

    /** Keys the current worker has bytes for. */
    private known = new Set<number>();
    private readonly keys = new WeakMap<Uint8Array, number>();
    /** Bytes that are part of other bytes, so they can be sent as a place in them. */
    private readonly origin = new WeakMap<Uint8Array, { parent: Uint8Array; offset: number }>();
    private readonly released = { keys: [] as number[], handles: [] as number[] };
    private releaseTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly dataRegistry = new FinalizationRegistry<{ key: number }>(({ key }) => this.queueRelease([key], []));
    private readonly previewRegistry = new FinalizationRegistry<{ handles: number[]; generation: number }>(({ handles, generation }) => {
        if (generation === this.generation) this.queueRelease([], handles);
    });

    /** Files in the session, to put back into a new worker. */
    private readonly session: { id: string; name: string; data: Uint8Array; how: SessionFile['how'] }[] = [];
    private names: readonly string[] = [];
    /** What hung or was stopped, and why: not read that way again. */
    private readonly poisoned = new Map<string, string>();
    private readonly listeners = new Set<(event: EngineEvent) => void>();

    constructor(
        private readonly connect: () => Transport,
        private readonly hangLimit = HANG_LIMIT * 1000
    ) {}

    on(listener: (event: EngineEvent) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private emit(event: EngineEvent) {
        for (const l of this.listeners) l(event);
    }

    private start(): Transport {
        const t = this.connect();
        t.onmessage = (m) => this.receive(m);
        t.onerror = (message) => this.kill(`The worker reading it stopped with an error (${message}).`);
        this.transport = t;
        this.known = new Set();
        this.lastSign = Date.now();
        this.watchdog ??= setInterval(() => this.watch(), 500);
        return t;
    }

    private watch() {
        if (!this.pending.size) return;
        if (Date.now() - this.lastSign > this.hangLimit)
            this.kill(
                `It ran for more than ${Math.round(this.hangLimit / 1000)} seconds without finishing, so it was stopped. A file made to hang parsers does this; so can a very big file on a slow computer.`
            );
    }

    private receive(m: FromWorker) {
        this.lastSign = Date.now();
        const p = this.pending.get(m.id);
        if (m.type === 'start') {
            this.current = m.id;
            return;
        }
        if (this.current === m.id) this.current = null;
        if (!p) return;
        this.pending.delete(m.id);
        if (m.type === 'done') p.resolve(m.result);
        else {
            const error = new Error(m.message);
            error.name = m.name;
            p.reject(error);
        }
    }

    private send(id: number, p: Pending) {
        const t = this.transport ?? this.start();
        if (this.pending.size === 0) this.lastSign = Date.now();
        this.pending.set(id, p);
        t.post({ id, request: p.build() });
    }

    private request<O extends Request['op']>(what: string, build: () => Extract<Request, { op: O }>, poison?: string): Promise<Results[O]> {
        const stopped = poison && this.poisoned.get(poison);
        if (stopped) return Promise.reject(new Stopped(stopped));
        return new Promise((resolve, reject) => this.send(this.nextId++, { build, what, poison, resolve: resolve as (v: unknown) => void, reject }));
    }

    /**
     * Stops the worker: the request it's on fails with Stopped (and isn't
     * tried again), a new worker gets the session's files back, and the
     * other requests go to it.
     */
    kill(reason: string) {
        // The worker takes requests strictly in order, so the one it's stuck on is the one it said it started or, if it
        // stuck before saying so, the oldest one waiting.
        const culprit = (this.current !== null ? this.pending.get(this.current) : undefined) ?? this.pending.values().next().value;
        this.transport?.terminate();
        this.transport = null;
        this.current = null;
        this.generation++;
        const waiting = [...this.pending.entries()].filter(([, p]) => p !== culprit);
        this.pending.clear();
        if (culprit) {
            if (culprit.poison) this.poisoned.set(culprit.poison, `${culprit.what}: ${reason}`);
            culprit.reject(new Stopped(`${culprit.what}: ${reason}`));
            this.emit({ kind: 'stopped', op: culprit.build().op, what: culprit.what, reason });
        }
        // The new worker: the names, the session's files, then what was waiting.
        this.start();
        if (this.names.length) this.send(this.nextId++, { build: () => ({ op: 'names', names: this.names }), what: 'Setting names', resolve: () => {}, reject: () => {} });
        for (const f of this.session)
            this.send(this.nextId++, {
                build: () => ({ op: 'add', name: f.name, data: this.ref(f.data), how: f.how }),
                what: `Adding ${f.name}`,
                poison: this.poisonKey(f.data),
                resolve: () => {},
                reject: () => this.forget(f.id),
            });
        for (const [id, p] of waiting) this.send(id, p);
        this.emit({ kind: 'restarted', generation: this.generation });
    }

    /** Stops whatever the worker is on, at the user's say. */
    stop(what?: string) {
        if (this.pending.size) this.kill(what ?? 'Stopped.');
    }

    /** True while the worker is working on something. */
    get busy(): boolean {
        return this.pending.size > 0;
    }

    private keyOf(data: Uint8Array): number {
        let key = this.keys.get(data);
        if (key === undefined) {
            key = this.nextKey++;
            this.keys.set(data, key);
            this.dataRegistry.register(data, { key });
        }
        return key;
    }

    private poisonKey(data: Uint8Array, as = ''): string {
        return `${this.keyOf(data)}:${as}`;
    }

    /** The bytes as the worker should get them: by key if it has them, as a place in bytes it has, or (once) as themselves. */
    private ref(data: Uint8Array): DataRef {
        const key = this.keyOf(data);
        if (this.known.has(key)) return { key };
        this.known.add(key);
        const o = this.origin.get(data);
        if (o) return { key, parent: this.ref(o.parent), offset: o.offset, length: data.length };
        // Only the bytes in view: a part of a bigger buffer would otherwise bring the whole buffer.
        return { key, data: whole(data) ? data : data.slice() };
    }

    /** Bytes the worker sent with a key of its own: it has them, so they go back by key. */
    private adopt(bytes: Uint8Array, key: number): Uint8Array {
        this.keys.set(bytes, key);
        this.known.add(key);
        this.dataRegistry.register(bytes, { key });
        return bytes;
    }

    private queueRelease(keys: number[], handles: number[]) {
        for (const k of keys) if (this.known.delete(k)) this.released.keys.push(k);
        this.released.handles.push(...handles);
        this.releaseTimer ??= setTimeout(() => {
            this.releaseTimer = null;
            const { keys: k, handles: h } = this.released;
            if (!k.length && !h.length) return;
            this.released.keys = [];
            this.released.handles = [];
            if (this.transport) this.send(this.nextId++, { build: () => ({ op: 'release', keys: k, handles: h }), what: 'Freeing memory', resolve: () => {}, reject: () => {} });
        }, 1000);
    }

    private forget(id: string) {
        const i = this.session.findIndex((f) => f.id === id);
        if (i >= 0) this.session.splice(i, 1);
    }

    setNames(names: readonly string[]) {
        this.names = names;
        void this.request('Setting names', () => ({ op: 'names', names })).catch(() => {});
    }

    async add(name: string, data: Uint8Array, how: SessionFile['how']): Promise<Results['add']> {
        const result = await this.request<'add'>(`Adding ${name}`, () => ({ op: 'add', name, data: this.ref(data), how }), this.poisonKey(data));
        if (result.file) this.session.push({ id: result.file.id, name, data, how });
        return result;
    }

    async remove(id: string): Promise<Results['remove']> {
        this.forget(id);
        return this.request<'remove'>(`Removing ${id}`, () => ({ op: 'remove', id }));
    }

    async inspect(data: Uint8Array, { name, shownName, as, near }: { name: string | null; shownName: string; as?: string; near?: string }): Promise<UiInspection> {
        const generation = this.generation;
        const wire = await this.request<'inspect'>(
            `Reading ${shownName}${as ? ` as ${formatOf(as).name}` : ''}`,
            () => ({ op: 'inspect', data: this.ref(data), name, shownName, as, near }),
            this.poisonKey(data, as)
        );
        return this.fromWire(wire, data, generation);
    }

    async palettes(name: string, data: Uint8Array): Promise<NamedPalette[]> {
        return this.request<'palettes'>(`Looking for palettes in ${name}`, () => ({ op: 'palettes', name, data: this.ref(data) }), `palettes:${this.poisonKey(data)}`);
    }

    /** The first of these files in the session, with its bytes. */
    async find(names: string[], near?: string): Promise<{ name: string; data: Uint8Array } | null> {
        const hit = await this.request<'find'>(`Finding ${names[0]}`, () => ({ op: 'find', names, near }));
        return hit && { name: hit.name, data: this.adopt(hit.data.bytes, hit.data.key) };
    }

    async readNames(name: string, data: Uint8Array): Promise<string[]> {
        return this.request<'readNames'>(`Reading names from ${name}`, () => ({ op: 'readNames', data: this.ref(data) }), `names:${this.poisonKey(data)}`);
    }

    private call<T>(what: string, handle: number, generation: number, args: (number | boolean | undefined)[] = []): Promise<T> {
        if (generation !== this.generation) return Promise.reject(new Stopped('The worker was restarted since this was opened; open the file again.'));
        return this.request<'call'>(what, () => ({ op: 'call', handle, args }), `call:${generation}:${handle}`) as Promise<T>;
    }

    private fromWire(wire: WireInspection, data: Uint8Array, generation: number): UiInspection {
        const handles: number[] = [];
        const preview = (p: WirePreview): UiPreview => {
            switch (p.kind) {
                case 'images': {
                    const { toggle, ...rest } = p;
                    if (!toggle) return rest;
                    handles.push(toggle.off);
                    return { ...rest, toggle: { label: toggle.label, off: () => this.call<IndexedImage[]>('Drawing the other view', toggle.off, generation) } };
                }
                case 'picture': {
                    const { toggle, ...rest } = p;
                    if (!toggle) return rest;
                    handles.push(toggle.off);
                    return { ...rest, toggle: { label: toggle.label, off: () => this.call<Uint8Array>('Drawing the other view', toggle.off, generation) } };
                }
                case 'video': {
                    const { frame, ...rest } = p;
                    handles.push(frame);
                    return { ...rest, frame: (i: number, playing?: boolean) => this.call<VideoFrame>(`Decoding frame ${i + 1}`, frame, generation, [i, playing]) };
                }
                case 'stack':
                    return { kind: 'stack', items: p.items.map((item) => ({ title: item.title, preview: preview(item.preview) })) };
                default:
                    return p;
            }
        };
        const entry = (e: WireEntry): Entry => {
            const { data: where, format: _format, ...rest } = e;
            let bytes: Uint8Array;
            if ('offset' in where) {
                bytes = data.subarray(where.offset, where.offset + where.length);
                this.origin.set(bytes, { parent: data, offset: where.offset });
            } else bytes = this.adopt(where.bytes, where.key);
            return { ...rest, data: bytes };
        };
        const { format, companions, checks, alternatives, entries, preview: wirePreview, ...parsed } = wire;
        const shown = wirePreview && preview(wirePreview);
        if (shown && handles.length) this.previewRegistry.register(shown, { handles, generation });
        return {
            format: formatOf(format),
            companions,
            parsed: { ...parsed, entries: entries?.map(entry), preview: shown },
            entryFormats: entries?.map((e) => e.format) ?? [],
            checks,
            alternatives: alternatives.map(formatOf),
        };
    }
}

/** A transport to a real worker. */
export function workerTransport(worker: Worker): Transport {
    const t: Transport = {
        post: (message) => worker.postMessage(message),
        terminate: () => worker.terminate(),
        onmessage: null,
        onerror: null,
    };
    worker.onmessage = (event: MessageEvent<FromWorker>) => t.onmessage?.(event.data);
    worker.onerror = (event) => {
        event.preventDefault();
        t.onerror?.(event.message || 'unknown');
    };
    return t;
}
