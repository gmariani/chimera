/** A DOS/16M module's header: 176 bytes (see dos16m.ts). Kept apart from the reader so the sniffers don't load it. */
const HEADER = 0xb0;

/**
 * A DOS/16M module saved on its own, as Chimera saves them: "BW", a whole header, and a name ending .EXP, as the
 * extender's modules have.
 */
export function sniffDos16mModule(data: Uint8Array): boolean {
    if (data.length < HEADER || data[0] !== 0x42 || data[1] !== 0x57) return false;
    let name = '';
    for (let i = 0x70; i < HEADER && data[i]; i++) {
        if (data[i] < 0x20 || data[i] > 0x7e) return false;
        name += String.fromCharCode(data[i]);
    }
    return /^[^\\/:]{1,59}\.EXP$/i.test(name);
}
