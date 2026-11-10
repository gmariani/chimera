/** Creative Voice: "Creative Voice File" and 0x1A, then a header of at least 26 bytes. */
export function sniffVoc(data: Uint8Array): boolean {
    const signature = 'Creative Voice File\x1a';
    if (data.length < 26) return false;
    for (let i = 0; i < signature.length; i++) if (data[i] !== signature.charCodeAt(i)) return false;
    return true;
}
