/**
 * How much a file may make the app allocate. A header can claim any size, and
 * files made to break parsers do exactly that (a 65535 × 65535 picture is
 * 17 GB as RGBA), so every size read from a file is checked against these
 * before anything is allocated with it: past them, the file is refused with
 * a TooBig error, which the app reports as a sign of a crafted file.
 */

/** 64 megapixels (256 MB as RGBA): more than any real picture or frame in the formats read here. */
export const MAX_PIXELS = 1 << 26;
/** 512 MB of decoded data from one stream (inflated, unpacked, decoded sound). */
export const MAX_BYTES = 1 << 29;

/** A size from the file past what the app will allocate. */
export class TooBig extends Error {
    override name = 'TooBig';
}

const n = (v: number) => v.toLocaleString('en-US');

/** Throws TooBig unless `bytes` is a whole number of bytes the app will allocate; returns it. */
export function checkBytes(bytes: number, what: string, max = MAX_BYTES): number {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error(`${what} would be ${n(bytes)} bytes, which can't be.`);
    if (bytes > max) throw new TooBig(`${what} would be ${n(bytes)} bytes, more than the ${n(max)} the app allows.`);
    return bytes;
}

/** Throws TooBig unless a width × height picture is one the app will draw; returns the pixel count. */
export function checkPixels(width: number, height: number, what = 'The picture'): number {
    // A negative or fractional size is a broken file, not a big one.
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 0 || height < 0) throw new Error(`${what} is ${width} × ${height}, which can't be.`);
    if (width * height > MAX_PIXELS) throw new TooBig(`${what} is ${n(width)} × ${n(height)} (${n(width * height)} pixels), more than the ${n(MAX_PIXELS)} the app will draw.`);
    return width * height;
}

/** A zeroed buffer for a width × height picture, `channels` bytes a pixel, once the size is checked. */
export function pixelBuffer(width: number, height: number, channels = 1, what?: string): Uint8Array {
    return new Uint8Array(checkPixels(width, height, what) * channels);
}

/**
 * Throws unless `count` records of `size` bytes each fit in the `room` bytes
 * there are, as a count from a header must; returns the count. Checked before
 * making anything per record, since a count can be in the billions.
 */
export function checkCount(count: number, size: number, room: number, what: string): number {
    const most = Math.floor(Math.max(0, room) / size);
    if (!Number.isSafeInteger(count) || count < 0 || count > most) throw new Error(`${what}: the header says ${n(count)}, but the ${n(Math.max(0, room))} bytes there are can hold at most ${n(most)}.`);
    return count;
}

/** What one file may decode in all, across its frames or parts: each takes from it, and past it the file is refused. */
export class Budget {
    private used = 0;
    constructor(
        private readonly what: string,
        private readonly max = MAX_BYTES,
    ) {}

    take(bytes: number): void {
        this.used += bytes;
        if (this.used > this.max) throw new TooBig(`${this.what} would come to more than the ${n(this.max)} bytes the app allows for one file.`);
    }
}
