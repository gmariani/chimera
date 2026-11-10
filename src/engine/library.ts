import { append } from '../core/math';
import type { Companion, Entry } from '../core/types';
import { detect } from '../formats';
import { namesFromText } from '../formats/mix/names';
import { sniffText } from '../formats/westwood/sniff';

/**
 * The session's files, kept where the parsers run: every file opened from
 * disk or added for others to use, and every named file inside those
 * archives, so a format can draw on its companions (a map finds its theater's
 * tiles, a voxel model its animation). Their INIs also give file names: TS and
 * RA2 archives keep none, but rules.ini and the rest name nearly every asset
 * (see namesFromText).
 */

/** How deep to look inside archives within archives (RA keeps theaters a level down in MAIN.MIX). */
const MAX_DEPTH = 3;

/** One file the user brought into the session, and what it holds. */
export interface SessionFile {
    /** Its name, made unique in the session: what companions' sources start with. */
    id: string;
    size: number;
    /** Opened to look at, or added for other files to use. */
    how: 'opened' | 'added';
    /** Named files inside it (and inside its archives), which others can find. */
    files: number;
    /** Archives inside it. */
    archives: number;
    /** Text files whose words are tried as file names. */
    texts: number;
}

/** The files in an archive, each with the name it goes by. */
function typed(entries: Entry[]): { entry: Entry; id: string; fileName: string }[] {
    return entries.map((entry) => ({ entry, id: detect(entry.data, entry.name).id, fileName: entry.name ?? entry.label }));
}

async function entriesOf(name: string, data: Uint8Array, names: readonly string[]): Promise<Entry[] | null> {
    const format = detect(data, name);
    if (format.id !== 'mix') return null;
    try {
        return (await format.load()).parse(data, { name, names }).entries ?? [];
    } catch {
        return null;
    }
}

/** The text files in an archive and the archives inside it. */
async function texts(name: string, data: Uint8Array, names: readonly string[], depth = 0): Promise<string[]> {
    const entries = depth < MAX_DEPTH ? await entriesOf(name, data, names) : null;
    if (!entries) return [];
    const found: string[] = [];
    for (const t of typed(entries)) {
        if (t.id === 'mix') append(found, await texts(t.fileName, t.entry.data, names, depth + 1));
        else if (sniffText(t.entry.data)) found.push(new TextDecoder('latin1').decode(t.entry.data));
    }
    return found;
}

const rootOf = (source: string) => source.split(' › ')[0];

export class Library {
    /** Every file by lowercase name. */
    private readonly files = new Map<string, Companion[]>();
    /** Each session file's bytes, so the same file isn't added twice. */
    private readonly added = new Map<Uint8Array, string>();
    /** Each session file's texts, to learn names from (and forget them again on removal). */
    private readonly textsOf = new Map<string, string[]>();
    /** Names the user gave (lists they loaded). */
    private userNames: readonly string[] = [];
    /** Names learned from the session's INIs. */
    learned: string[] = [];

    setUserNames(names: readonly string[]): void {
        this.userNames = names;
    }

    /** What to parse archives with: the user's names and those learned. */
    get names(): readonly string[] {
        return this.learned.length ? [...this.userNames, ...this.learned] : this.userNames;
    }

    private relearn(): void {
        const all = new Set([...this.textsOf.values()].flat());
        this.learned = all.size ? namesFromText(all) : [];
    }

    /** Adds a file and what's inside it: the session file, or null if it's already in (`opened` then says it was opened). */
    async add(name: string, data: Uint8Array, how: SessionFile['how']): Promise<{ file: SessionFile | null; existing?: string; brought: number }> {
        // The same file read from disk again comes as new bytes: one of the same name, size and contents
        // (at a spread of places, which a different build of an archive wouldn't share) is the one in use.
        const same = (other: Uint8Array) => other.length === data.length && Array.from({ length: 64 }, (_, i) => Math.floor((i * (data.length - 1)) / 63)).every((at) => other[at] === data[at]);
        const existing = this.added.get(data) ?? [...this.added].find(([other, id]) => id.replace(/ \(\d+\)$/, '').toLowerCase() === name.toLowerCase() && same(other))?.[1];
        if (existing) return { file: null, existing, brought: 0 };
        // A unique id: the name, numbered if another file of that name is already in.
        const taken = new Set(this.added.values());
        let id = name;
        for (let n = 2; taken.has(id); n++) id = `${name} (${n})`;
        this.added.set(data, id);

        const key = name.toLowerCase();
        this.files.set(key, [...(this.files.get(key) ?? []), { data, source: id }]);
        // Learn names from its INIs first, so what's indexed below is found by name.
        const own = await texts(name, data, this.names);
        this.textsOf.set(id, own);
        if (own.length) this.relearn();
        const count = { files: 0, archives: 0 };
        await this.collect(name, data, id, count);
        return { file: { id, size: data.length, how, files: count.files, archives: count.archives, texts: own.length }, brought: 1 + count.files };
    }

    /** Indexes every named file in an archive (and the archives inside it) under `source`; counts what it found. */
    private async collect(name: string, data: Uint8Array, source: string, count: { files: number; archives: number }, depth = 0): Promise<void> {
        const entries = depth < MAX_DEPTH ? await entriesOf(name, data, this.names) : null;
        if (!entries) return;
        if (depth > 0) count.archives++;
        const path = depth === 0 ? source : `${source} › ${name}`;
        for (const t of typed(entries)) {
            if (t.entry.name) {
                const key = t.entry.name.toLowerCase();
                const list = this.files.get(key) ?? [];
                if (!list.some((c) => c.data === t.entry.data)) {
                    list.push({ data: t.entry.data, source: path });
                    this.files.set(key, list);
                    count.files++;
                }
            }
            if (t.id === 'mix') await this.collect(t.fileName, t.entry.data, path, count, depth + 1);
        }
    }

    remove(id: string): void {
        for (const [key, list] of this.files) {
            const kept = list.filter((c) => rootOf(c.source) !== id);
            if (kept.length) this.files.set(key, kept);
            else this.files.delete(key);
        }
        for (const [data, owner] of this.added) if (owner === id) this.added.delete(data);
        if (this.textsOf.delete(id)) this.relearn();
    }

    /** Everything under this name, those in `near` (an archive path) first. */
    find(name: string, near?: string): Companion[] {
        const list = this.files.get(name.toLowerCase()) ?? [];
        if (!near) return list;
        // The same archive first, then others under the same file opened from disk, then the rest.
        const root = rootOf(near);
        const rank = (c: Companion) => (c.source === near ? 0 : rootOf(c.source) === root ? 1 : 2);
        return [...list].sort((a, b) => rank(a) - rank(b));
    }

    /** The id of the session file with these bytes, if it's in. */
    idOf(data: Uint8Array): string | undefined {
        return this.added.get(data);
    }
}
