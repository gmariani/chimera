/**
 * HMI's Sound Operating System (SOS) driver libraries (HMIDRV.386, HMIDET.386: the sound card drivers and the
 * card-detection drivers DOS games of 1993–96 shipped, Command & Conquer among them). A file header, then the drivers
 * back to back, each a header and its code. The layouts are SOS.H's _FILEHEADER and _DRIVERHEADER (in the Red Alert
 * source EA released, REDALERT/WIN32LIB), packed to 4 bytes, each WORD 32 bits. Kept apart from the reader so the
 * sniffers don't load it.
 */

export const SOS_FILE_HEADER = 44;
export const SOS_DRIVER_HEADER = 48;
/** No library has more drivers than this (TD's have 96 and 77). */
const MAX_DRIVERS = 4096;

export interface SosDriver {
    /** Where its header starts. */
    at: number;
    name: string;
    /** The header's lNextDriver. */
    next: number;
    size: number;
    device: number;
    extender: number;
}

export interface SosLayout {
    name: string;
    count: number;
    first: number;
    sizeField: number;
    drivers: SosDriver[];
    /** Where the last driver ends: anything after it isn't the library's. */
    end: number;
}

/** A NUL-terminated name of printable characters in a field of `length` bytes, or null. */
function name(data: Uint8Array, at: number, length: number): string | null {
    const field = data.subarray(at, at + length);
    const end = field.indexOf(0);
    if (end <= 0) return null;
    for (let i = 0; i < end; i++) if (field[i] < 0x20 || field[i] > 0x7e) return null;
    return String.fromCharCode(...field.subarray(0, end));
}

/** The library's header and its drivers, walked back to back from the first, or what doesn't fit. */
export function sosLayout(data: Uint8Array): SosLayout | string {
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (data.length < SOS_FILE_HEADER + SOS_DRIVER_HEADER) return `It's ${data.length} bytes, too short for a header and a driver.`;
    const library = name(data, 0, 32);
    if (library === null) return "Its first 32 bytes aren't a name.";
    const count = v.getUint32(32, true);
    const first = v.getUint32(36, true);
    if (count === 0 || count > MAX_DRIVERS) return `It says it has ${count.toLocaleString('en-US')} drivers.`;
    if (first !== SOS_FILE_HEADER) return `Its first driver is at ${first.toLocaleString('en-US')}, not right after the header (${SOS_FILE_HEADER}).`;
    const drivers: SosDriver[] = [];
    let at = first;
    while (drivers.length < count) {
        if (at + SOS_DRIVER_HEADER > data.length) return `Driver ${drivers.length + 1}'s header runs past the end of the file.`;
        const driverName = name(data, at, 32);
        if (driverName === null) return `Driver ${drivers.length + 1} (at ${at.toLocaleString('en-US')}) has no name.`;
        const size = v.getUint32(at + 36, true);
        if (at + SOS_DRIVER_HEADER + size > data.length) return `Driver ${drivers.length + 1}, ${driverName}, says it's ${size.toLocaleString('en-US')} bytes, more than the rest of the file.`;
        drivers.push({ at, name: driverName, next: v.getUint32(at + 32, true), size, device: v.getUint32(at + 40, true), extender: v.getUint32(at + 44, true) });
        at += SOS_DRIVER_HEADER + size;
    }
    return { name: library, count, first, sizeField: v.getUint32(40, true), drivers, end: at };
}

export function sniffSos(data: Uint8Array): boolean {
    return typeof sosLayout(data) !== 'string';
}
