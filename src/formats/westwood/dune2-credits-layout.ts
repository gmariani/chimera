/**
 * Dune II's credits (CREDITS.ENG, .FRE, .GER), split as the game splits them:
 * strings ending at a CR (the next starts a row lower) or at 0x05 (the next
 * shares its row), the whole ending with a NUL. A style byte at a string's
 * start says how it's drawn. Kept apart from the reader so the sniffers don't
 * load it.
 */

export interface CreditString {
    /** Where it starts: its style byte, if it has one. */
    at: number;
    /** 1 to 4, or 0 when it has none (it's centered). */
    style: number;
    text: string;
    /** Where its text starts and ends. */
    from: number;
    to: number;
    /** What ends it: 0x05, a CR, or the NUL (or the file's end, -1). */
    separator: number;
}

/** The game reads them into a 64,000-byte screen buffer; anything longer isn't credits. */
export const MOST = 64000;

/** Whether a byte is one the game draws: a character (anything from a space up), not a control byte. */
const drawn = (v: number) => v >= 0x20;

export function creditStrings(data: Uint8Array): { strings: CreditString[]; end: number } {
    const strings: CreditString[] = [];
    let p = 0;
    while (p < data.length && data[p] !== 0) {
        const at = p;
        const style = data[p] >= 1 && data[p] <= 4 ? data[p++] : 0;
        const from = p;
        while (p < data.length && data[p] !== 0 && data[p] !== 5 && data[p] !== 13) p++;
        let text = '';
        for (let i = from; i < p; i++) text += String.fromCharCode(data[i]);
        const separator = p < data.length ? data[p] : -1;
        strings.push({ at, style, text, from, to: p, separator });
        if (separator === 5 || separator === 13) p++;
    }
    return { strings, end: p };
}

/**
 * Credits by content: a NUL ending them (and nothing but zeros after it), no control bytes but the style bytes, 0x05
 * and CR, no LF (the game's lines end in a bare CR), and a style byte starting at least one string.
 */
export function sniffDuneCredits(data: Uint8Array): boolean {
    if (data.length < 2 || data.length > MOST) return false;
    const nul = data.indexOf(0);
    if (nul < 1) return false;
    for (let i = nul + 1; i < data.length; i++) if (data[i]) return false;
    for (let i = 0; i < nul; i++) if (!drawn(data[i]) && !(data[i] >= 1 && data[i] <= 5) && data[i] !== 13) return false;
    return creditStrings(data).strings.some((s) => s.style);
}
