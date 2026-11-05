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

    /**
     * This INI with another read over it, as TS and RA2 read a map over rules.ini: its keys replace these, its
     * sections are added. A list of types ([BuildingTypes]) gains the other's entries instead, since the game
     * registers each value it reads and a map's "0=" isn't rules.ini's "0=".
     */
    overriddenBy(other: Ini): Ini {
        const sections = this.sections.map((s) => ({ ...s, entries: [...s.entries] }));
        const byName = new Map(sections.map((s) => [s.name.toLowerCase(), s]));
        for (const s of other.sections) {
            const mine = byName.get(s.name.toLowerCase());
            if (!mine) {
                const copy = { ...s, entries: [...s.entries] };
                sections.push(copy);
                byName.set(s.name.toLowerCase(), copy);
            } else if (/Types$/i.test(s.name)) {
                const values = new Set(mine.entries.map((e) => e.value.toLowerCase()));
                mine.entries.push(...s.entries.filter((e) => !values.has(e.value.toLowerCase())).map((e, i) => ({ ...e, key: `+${i}` })));
            } else {
                for (const e of s.entries) {
                    const at = mine.entries.findIndex((m) => m.key.toLowerCase() === e.key.toLowerCase());
                    if (at >= 0) mine.entries[at] = e;
                    else mine.entries.push(e);
                }
            }
        }
        const merged = Object.create(Ini.prototype) as Ini;
        (merged as { sections: IniSection[] }).sections = sections;
        return merged;
    }
}
