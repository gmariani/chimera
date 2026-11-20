/** AVI video: a RIFF file of the form "AVI ". Kept apart from the reader so the sniffers don't load it. */
export function sniffAvi(data: Uint8Array): boolean {
    const tag = (at: number, s: string) => [...s].every((c, i) => data[at + i] === c.charCodeAt(0));
    return data.length >= 24 && tag(0, 'RIFF') && tag(8, 'AVI ');
}
