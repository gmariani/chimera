/**
 * Dune II's compressed text. A byte from 0x80 up is two letters: its bits
 * 1aaaabbb give the first from 16 common ones (" etainosrlhcdupm"), and with
 * that the second from 8 that most often follow it. 0x1B then a byte is the
 * character 0x7F more than that byte (the accented letters of the game's
 * font). Everything else is itself. OpenDUNE's String_DecompressAndTranslate
 * (src/string.c), https://github.com/OpenDUNE/OpenDUNE.
 */

const FIRST = ' etainosrlhcdupm';
/** For each first letter, in FIRST's order, the 8 letters that can follow it. */
const SECOND = [
    'tasio wb',
    ' rnsdalm',
    'h ieoras',
    'nrtlc sy',
    'nstcloer',
    ' dtgesio',
    'nr ufmsw',
    ' tep.ica',
    'e oiadur',
    ' laeiyod',
    'eia otru',
    'etoakhlr',
    ' eiu,.oa',
    'nsrctlai',
    'leoiratp',
    'eaoip bm',
];

/** The upper half of the PC's own character set (code page 437), which DOS games' fonts follow: their accented letters. */
const CP437 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0';

/** DOS text: bytes from 0x80 up as the PC's own character set (C&C's and Dune II's fonts follow it: "Gebäude", "Amélioration", and box lines). */
export function dosText(bytes: Uint8Array): string {
    let out = '';
    for (const c of bytes) out += c >= 0x80 ? CP437[c - 0x80] : String.fromCharCode(c);
    return out;
}

/**
 * Whether these bytes are Dune II's compressed text: letter pairs make a lot of the bytes high (half and more in the game's
 * files), and spread them over many values. Plain text's high bytes are a few accented letters or box lines: C&C's
 * German and French string tables use 7 and 10 different ones, Dune II's compressed ones 99 to 124.
 */
export function looksCompressed(bytes: Uint8Array): boolean {
    let text = 0;
    let high = 0;
    const values = new Set<number>();
    for (const c of bytes) {
        if (!c) continue;
        text++;
        if (c >= 0x80) {
            high++;
            values.add(c);
        }
    }
    return text > 0 && high / text >= 0.2 && values.size >= 48;
}

/** The text these bytes make, decompressed; and how many of them were letter pairs. */
export function dune2Text(bytes: Uint8Array): { text: string; pairs: number } {
    let out = '';
    let pairs = 0;
    for (let i = 0; i < bytes.length; i++) {
        const c = bytes[i];
        if (c & 0x80) {
            const v = c & 0x7f;
            out += FIRST[v >> 3] + SECOND[v >> 3][v & 7];
            pairs++;
        } else if (c === 0x1b && i + 1 < bytes.length) {
            const code = Math.min(0xff, 0x7f + bytes[++i]);
            out += code >= 0x80 ? CP437[code - 0x80] : String.fromCharCode(code);
        } else {
            out += String.fromCharCode(c);
        }
    }
    return { text: out, pairs };
}
