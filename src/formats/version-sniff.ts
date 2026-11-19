/**
 * A Windows version resource on its own (saved from a program): VS_VERSION_INFO as its root node's key, in UTF-16
 * after a 6-byte header (32-bit) or in plain text after a 4-byte one (16-bit), and a length that covers the key. Kept
 * apart from the reader so the sniffers don't load it.
 */
export function sniffVersion(data: Uint8Array): boolean {
    if (data.length < 40) return false;
    const key = 'VS_VERSION_INFO\0';
    const wide = [...key].every((c, i) => data[6 + i * 2] === c.charCodeAt(0) && data[7 + i * 2] === 0);
    const narrow = [...key].every((c, i) => data[4 + i] === c.charCodeAt(0));
    const length = data[0] | (data[1] << 8);
    return (wide && length >= 38) || (narrow && length >= 20);
}
