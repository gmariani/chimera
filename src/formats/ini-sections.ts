/** Reading INI sections, shared by the INI parser and TD maps (which read their mission's INI). */

export interface IniSection {
    name: string;
    offset: number;
    length: number;
    entries: { key: string; value: string; offset: number; length: number }[];
}

/** Byte offsets assume one byte per character, which holds for these Latin-1 files. */
export function iniSections(text: string): IniSection[] {
    const out: IniSection[] = [];
    let offset = 0;
    for (const raw of text.split('\n')) {
        const line = raw.replace(/\r$/, '');
        const content = line.replace(/;.*$/, '').trim();
        const header = content.match(/^\[(.+)\]$/);
        if (header) {
            out.push({ name: header[1], offset, length: 0, entries: [] });
        } else if (content && out.length) {
            const eq = content.indexOf('=');
            if (eq > 0) out.at(-1)!.entries.push({ key: content.slice(0, eq).trim(), value: content.slice(eq + 1).trim(), offset, length: line.length });
        }
        offset += raw.length + 1;
        if (out.length) out.at(-1)!.length = Math.min(offset, text.length) - out.at(-1)!.offset;
    }
    return out;
}

/** Looks sections and keys up without regard to case, as the games do. */
export class Ini {
    readonly sections: IniSection[];

    constructor(text: string) {
        this.sections = iniSections(text);
    }

    static of(data: Uint8Array): Ini {
        return new Ini(new TextDecoder('latin1').decode(data));
    }

    section(name: string): IniSection | undefined {
        return this.sections.find((s) => s.name.toLowerCase() === name.toLowerCase());
    }

    get(section: string, key: string): string | undefined {
        return this.section(section)?.entries.find((e) => e.key.toLowerCase() === key.toLowerCase())?.value;
    }

    /** Every entry of a section, as key → value. */
    entries(section: string): [string, string][] {
        return this.section(section)?.entries.map((e) => [e.key, e.value]) ?? [];
    }
}
