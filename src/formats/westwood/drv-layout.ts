/**
 * Westwood's own sound drivers (.DRV: Dune II's ALFX.DRV and PCSOUND.DRV), as
 * far as the start of one shows: two jumps, then wherever the first lands, a
 * dispatcher that takes a function's number in BX and jumps through a table.
 * Kept apart from the reader so the sniffers don't load it.
 */

export interface DrvLayout {
    /** Where the first jump lands: the dispatcher, which the game calls. */
    dispatcher: number;
    /** Where the second lands: what the game's timer calls. */
    timer: number;
    /** The function table: where it is, and each function's code. */
    table: number;
    functions: number[];
    /** Where a number past the table goes: a bare return. */
    refused: number;
}

/** The dispatcher's code: cmp bx,n; ja refused; shl bx,1; jmp [cs:bx+table]. */
const DISPATCHER = 12;

/** The layout, or why it isn't one of these drivers. */
export function drvLayout(data: Uint8Array): DrvLayout | string {
    if (data.length < 6 + DISPATCHER) return 'It’s too short for a driver.';
    if (data[0] !== 0xe9 || data[3] !== 0xe9) return 'It doesn’t start with two jumps.';
    const word = (at: number) => data[at] | (data[at + 1] << 8);
    const dispatcher = (3 + word(1)) & 0xffff;
    const timer = (6 + word(4)) & 0xffff;
    if (dispatcher + DISPATCHER > data.length || timer >= data.length) return 'Its jumps land outside the file.';
    const d = data.subarray(dispatcher, dispatcher + DISPATCHER);
    if (!(d[0] === 0x83 && d[1] === 0xfb && d[3] === 0x77 && d[5] === 0xd1 && d[6] === 0xe3 && d[7] === 0x2e && d[8] === 0xff && d[9] === 0xa7))
        return 'Where its first jump lands isn’t a dispatcher: code that takes a function’s number in BX and jumps through a table.';
    const count = d[2] + 1;
    if (count > 64) return `Its dispatcher takes ${count} functions, more than any of these drivers has.`;
    const table = word(dispatcher + 10);
    if (table + count * 2 > data.length) return 'Its table of functions runs past the end of the file.';
    const refused = (dispatcher + 5 + ((d[4] << 24) >> 24)) & 0xffff;
    return { dispatcher, timer, table, functions: Array.from({ length: count }, (_, i) => word(table + i * 2)), refused };
}

export function sniffDrv(data: Uint8Array): boolean {
    return typeof drvLayout(data) !== 'string';
}
