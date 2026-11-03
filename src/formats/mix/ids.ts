import { crc32 } from '../../core/crc32';

/**
 * MIX files store a 32-bit ID per file instead of its name. The ID is a hash of
 * the upper-cased name, so names can only be recovered by hashing candidates.
 */

/** Tiberian Dawn and Red Alert: rotate left by one and add, four characters at a time. */
export function classicId(name: string): number {
    const text = name.toUpperCase();
    let id = 0;
    for (let i = 0; i < text.length; ) {
        let a = 0;
        for (let j = 0; j < 4; j++, i++) {
            a >>>= 8;
            if (i < text.length) a = (a + ((text.charCodeAt(i) & 0xff) << 24)) >>> 0;
        }
        id = (((id << 1) | (id >>> 31)) + a) >>> 0;
    }
    return id;
}

/** Tiberian Sun and later: a CRC-32 of the name, padded to a multiple of four in Westwood's way. */
export function crcId(name: string): number {
    const text = name.toUpperCase();
    const bytes = Array.from(text, (c) => c.charCodeAt(0) & 0xff);
    const l = bytes.length;
    const a = l >> 2;
    if (l & 3) {
        bytes.push(l - (a << 2));
        for (let i = 3 - (l & 3); i > 0; i--) bytes.push(bytes[a << 2]);
    }
    return crc32(Uint8Array.from(bytes));
}

export type IdScheme = 'classic' | 'crc';

export const ID_SCHEMES: Record<IdScheme, { label: string; id: (name: string) => number }> = {
    classic: { label: 'Tiberian Dawn / Red Alert', id: classicId },
    crc: { label: 'Tiberian Sun / Red Alert 2', id: crcId },
};
