/**
 * Program information files (.pif). There's no signature at the start; from
 * Windows 3.0 the first section header, right after the 0x171-byte basic
 * section, is "MICROSOFT PIFEX" pointing back at it. Older files are just the
 * basic section: recognized only by name. Kept apart from the reader so the
 * sniffers don't load it.
 */

export const BASIC_SIZE = 0x171;

export interface PifSection {
    /** Where its header is. */
    at: number;
    name: string;
    next: number;
    dataAt: number;
    length: number;
}

/** The section headers, in the order they link, or null if they don't make a list that fits the file. */
export function pifSections(data: Uint8Array): PifSection[] | null {
    if (data.length < BASIC_SIZE + 22) return null;
    const u16 = (at: number) => data[at] | (data[at + 1] << 8);
    const out: PifSection[] = [];
    const seen = new Set<number>();
    for (let at = BASIC_SIZE; at !== 0xffff;) {
        if (seen.has(at) || at + 22 > data.length || out.length > 32) return null;
        seen.add(at);
        const raw = data.subarray(at, at + 16);
        const nul = raw.indexOf(0);
        if (nul <= 0) return null;
        const name = String.fromCharCode(...raw.subarray(0, nul));
        if (!/^[\x20-\x7e]+$/.test(name)) return null;
        const next = u16(at + 16);
        const dataAt = u16(at + 18);
        const length = u16(at + 20);
        if (dataAt + length > data.length) return null;
        out.push({ at, name, next, dataAt, length });
        at = next;
    }
    return out[0]?.name === 'MICROSOFT PIFEX' ? out : null;
}

export function sniffPif(data: Uint8Array): boolean {
    return data[0] === 0 && pifSections(data) !== null;
}
