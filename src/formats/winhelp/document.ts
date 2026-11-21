import type { DocumentBlock, DocumentLink, DocumentPage, DocumentParagraph, DocumentPicture, DocumentPreview, DocumentRun, DocumentStyle } from '../../core/types';
import { readPictures, type HelpPicture } from './pictures';
import type { HelpWindow } from './system';
import type { HelpBlock, HelpParagraph, HelpTarget, Topic } from './topics';

/**
 * A help file's topics as WinHelp drew them: each topic a page, its non-scrolling band above the rest, in the fonts
 * |FONT gives, with hotspots in WinHelp's green (a jump underlined, a popup underlined with dots), its pictures in
 * place, and its jumps and popups leading to the topics they name.
 */

/** WinHelp's color for hotspots. */
const GREEN = '#008000';

export interface DocumentSource {
    title: string;
    topics: Topic[];
    start: number;
    nameOf: (t: Topic) => string;
    topicAt: (offset: number) => Topic | null;
    contexts: { hash: number; offset: number }[];
    styles: DocumentStyle[];
    pictures: { name: string; picture: HelpPicture }[];
    /** The numbers of the |bm files it has, read or not. */
    bmFiles: Set<number>;
    embedded: { topic: string; data: Uint8Array }[];
    window?: HelpWindow;
}

export function buildDocument(src: DocumentSource): { preview: DocumentPreview; problems: string[] } {
    const problems: string[] = [];
    const pageOf = new Map(src.topics.map((t, i) => [t, i]));
    const byHash = new Map(src.contexts.map((c) => [c.hash, c.offset]));

    // Styles: each font as |FONT gives it, and again as a hotspot shows it.
    const styles: DocumentStyle[] = [];
    const styleKeys = new Map<string, number>();
    const styleOf = (font: number, link?: HelpTarget) => {
        const look = link && !link.plain ? (link.popup ? 'popup' : 'jump') : '';
        const key = `${font}:${look}`;
        let n = styleKeys.get(key);
        if (n === undefined) {
            const base = src.styles[font] ?? src.styles[0] ?? {};
            styles.push(look ? { ...base, color: GREEN, underline: look === 'popup' ? 'dotted' : 'single' } : base);
            n = styles.length - 1;
            styleKeys.set(key, n);
        }
        return n;
    };

    // Where hotspots lead.
    const links = new Map<HelpTarget, DocumentLink>();
    let broken = 0;
    const linkOf = (t: HelpTarget): DocumentLink => {
        let link = links.get(t);
        if (link) return link;
        const verb = t.popup ? 'Pops up' : 'Opens';
        if (t.macro !== undefined) link = { about: `Runs the macro ${t.macro}` };
        else if (t.file) link = { popup: t.popup, about: `${verb} a topic of ${t.file}${t.window ? `, in its window “${t.window}”` : ''}: not followed here` };
        else {
            const offset = t.offset ?? (t.hash !== undefined ? byHash.get(t.hash) : undefined);
            const topic = offset !== undefined ? src.topicAt(offset) : null;
            if (!topic) broken++;
            link = topic
                ? { page: pageOf.get(topic), popup: t.popup, about: `${verb} “${src.nameOf(topic)}”${t.window ? ` in window ${t.window}` : ''}` }
                : { popup: t.popup, about: `${verb} a topic it doesn’t have` };
        }
        links.set(t, link);
        return link;
    };

    // Pictures: the |bm files', by their number, and those held in topics, by theirs.
    const pictures: DocumentPicture[] = [];
    const addPicture = (p: HelpPicture) => {
        pictures.push({
            width: p.width,
            height: p.height,
            rgba: p.rgba,
            about: p.about,
            hotspots: p.hotspots.map((h) => ({ x: h.x, y: h.y, width: h.width, height: h.height, link: linkOf(hotspotTarget(h.code, h.hash, h.target)) })),
        });
        return pictures.length - 1;
    };
    const bm = new Map<number, number>();
    for (const { name, picture } of src.pictures) {
        const n = Number(name.replace(/^\D+/, ''));
        if (!bm.has(n)) bm.set(n, addPicture(picture));
    }
    const held = src.embedded.map((e, i) => {
        const r = readPictures(e.data, 0, e.data.length, `Picture ${i + 1} held in the topic “${e.topic}”`);
        problems.push(...r.problems);
        return r.pictures[0] ? addPicture(r.pictures[0]) : -1;
    });

    let missing = 0;
    const runOf = (r: HelpParagraph['runs'][number]): DocumentRun => {
        switch (r.kind) {
            case 'text':
                return { kind: 'text', text: r.text, style: styleOf(r.font, r.link), ...(r.link && { link: linkOf(r.link) }) };
            case 'picture': {
                const n = r.bm !== undefined ? bm.get(r.bm) : held[r.embedded ?? -1];
                if (n === undefined || n < 0) {
                    // One it has but can't read is said where it's read.
                    const absent = r.bm !== undefined && !src.bmFiles.has(r.bm);
                    if (absent) missing++;
                    return { kind: 'object', text: absent ? `[picture bm${r.bm}, which it doesn’t have]` : '[a picture that can’t be read]' };
                }
                return { kind: 'picture', picture: n, place: r.place, ...(r.link && { link: linkOf(r.link) }) };
            }
            default:
                return r;
        }
    };
    const paragraphOf = (p: HelpParagraph): DocumentParagraph => ({ ...p, runs: p.runs.map(runOf) });
    const blockOf = (b: HelpBlock): DocumentBlock => (b.kind === 'table' ? { ...b, rows: b.rows.map((row) => row.map((cell) => cell.map(paragraphOf))) } : paragraphOf(b));

    const pages: DocumentPage[] = src.topics.map((t) => ({
        title: src.nameOf(t),
        fixed: t.fixed.map(blockOf),
        body: t.body.map(blockOf),
        background: src.window?.background,
        fixedBackground: src.window?.fixedBackground,
    }));
    if (missing) problems.push(`Its topics show ${missing === 1 ? 'a picture' : `${missing.toLocaleString('en-US')} pictures`} it doesn’t have.`);
    return {
        preview: {
            kind: 'document',
            title: src.title,
            pages,
            start: Math.max(0, src.start),
            styles,
            pictures,
            note: `${broken ? `${broken.toLocaleString('en-US')} of its hotspots lead to topics it doesn’t have. ` : ''}Laid out as WinHelp drew it, as near as a browser can: fonts Windows had are swapped for ones like them, metafiles aren’t drawn, and buttons and windows from DLLs are said in words.`,
        },
        problems,
    };
}

/** Where a picture's hotspot leads: a macro, a context name by its hash, or a "name>window@file". */
function hotspotTarget(code: number, hash: number, target: string): HelpTarget {
    const popup = code === 0xe2 || code === 0xe6 || code === 0xea || code === 0xee;
    if (code === 0xc8 || code === 0xcc) return { popup: false, macro: target };
    if (code >= 0xe2 && code <= 0xe7) return { popup, hash };
    const [, window, file] = /^[^>@]*(?:>([^@]*))?(?:@(.*))?$/.exec(target) ?? [];
    return { popup, file: file || undefined, window: window || undefined, ...(file ? {} : { hash: contextHash(target.replace(/[>@].*$/, '')) }) };
}

/**
 * WinHelp's hash of a context name, which |CONTEXT is keyed by: for each character, 43 times the hash so far plus the
 * character's value from a table (letters fold to upper case, digits and some punctuation are moved), 32 bits; 1 for
 * none. As helpfile.txt gives it.
 */
export function contextHash(name: string): number {
    if (!name) return 1;
    let hash = 0;
    for (const c of new TextEncoder().encode(name)) hash = (Math.imul(hash, 43) + HASH_TABLE[c]) | 0;
    return hash >>> 0;
}

/** helpfile.txt's table, as signed bytes. */
const HASH_TABLE = Int8Array.from(
    [
        0x00, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xdb, 0xdc, 0xdd, 0xde, 0xdf, 0xe0, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xeb, 0xec, 0xed, 0xee, 0xef,
        0xf0, 0x0b, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xfb, 0xfc, 0xfd, 0x0c, 0xff, 0x0a, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
        0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0d,
        0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d, 0x2e, 0x2f,
        0x50, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x5b, 0x5c, 0x5d, 0x5e, 0x5f, 0x60, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x6b, 0x6c, 0x6d, 0x6e, 0x6f,
        0x70, 0x71, 0x72, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x7b, 0x7c, 0x7d, 0x7e, 0x7f, 0x80, 0x81, 0x82, 0x83, 0x0b, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x8b, 0x8c, 0x8d, 0x8e, 0x8f,
        0x90, 0x91, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0x9b, 0x9c, 0x9d, 0x9e, 0x9f, 0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xab, 0xac, 0xad, 0xae, 0xaf,
        0xb0, 0xb1, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xbb, 0xbc, 0xbd, 0xbe, 0xbf, 0xc0, 0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xcb, 0xcc, 0xcd, 0xce, 0xcf,
    ].map((v) => (v << 24) >> 24)
);
