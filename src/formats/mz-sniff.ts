/**
 * DOS programs (MZ): the header's sizes, checked against the file. Kept apart
 * from the reader so the sniffers don't load it. Programs for Windows and OS/2
 * start the same way, with their own header where the word at 0x3C points;
 * those are left to their readers.
 */

export interface MzLayout {
    /** "MZ", or "ZM", which early DOS accepted too. */
    signature: 'MZ' | 'ZM';
    /** Where the header ends and the program's image starts. */
    headerSize: number;
    /** Where the image ends, as the header says: DOS loads no further. */
    imageEnd: number;
    relocations: number;
    relocationsAt: number;
}

const word = (data: Uint8Array, at: number) => data[at] | (data[at + 1] << 8);

/** The layout, or why it isn't a DOS program. */
export function mzLayout(data: Uint8Array): MzLayout | string {
    if (data.length < 28) return 'It’s shorter than the 28 bytes of a DOS program’s header.';
    const signature = data[0] === 0x4d && data[1] === 0x5a ? 'MZ' : data[0] === 0x5a && data[1] === 0x4d ? 'ZM' : null;
    if (!signature) return 'It doesn’t start with "MZ".';
    if (data.length >= 64) {
        const next = (data[0x3c] | (data[0x3d] << 8) | (data[0x3e] << 16) | (data[0x3f] << 24)) >>> 0;
        const two = next >= 64 && next + 4 <= data.length ? String.fromCharCode(data[next], data[next + 1]) : '';
        if (two === 'NE' || two === 'LE' || two === 'LX' || (two === 'PE' && data[next + 2] === 0 && data[next + 3] === 0))
            return `It's a program for Windows or OS/2: the word at 0x3C points to its "${two}" header.`;
    }
    const lastPage = word(data, 2);
    const pages = word(data, 4);
    const headerSize = word(data, 8) * 16;
    const relocations = word(data, 6);
    const relocationsAt = word(data, 0x18);
    if (!pages) return 'Its header says it’s 0 pages long.';
    if (headerSize < 28) return `Its header is said to be ${headerSize} bytes, too short to hold itself.`;
    if (headerSize > data.length) return `Its header is said to be ${headerSize.toLocaleString('en-US')} bytes, more than the file.`;
    // Pages of 512 bytes, the last holding only this many (0: all of it).
    const imageEnd = lastPage ? (pages - 1) * 512 + lastPage : pages * 512;
    if (imageEnd < headerSize) return `It's said to end at ${imageEnd.toLocaleString('en-US')}, before its header does.`;
    if (relocations && (relocationsAt < 28 || relocationsAt + relocations * 4 > data.length))
        return `Its ${relocations.toLocaleString('en-US')} relocations are said to be at ${relocationsAt}, ${relocationsAt < 28 ? 'inside the header’s fields' : 'running past the end of the file'}.`;
    return { signature, headerSize, imageEnd, relocations, relocationsAt };
}

export function sniffMz(data: Uint8Array): boolean {
    return typeof mzLayout(data) !== 'string';
}
