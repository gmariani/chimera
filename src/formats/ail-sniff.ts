/**
 * Miles Design's Audio Interface Library (AIL) 2 drivers (.adv). The first
 * word is where the function table is; before it, text that ends in 0x1A
 * (the copyright line). The table is pairs of words, a function number and
 * where its code is, ending with 0xFFFF. Kept apart from the reader so the
 * sniffers don't load it.
 */

/** No more functions than this are looked at (AIL 2 defines 53). */
const MAX_FUNCTIONS = 1024;

export interface AilLayout {
    /** Where the function table is, and where the text before it ends (its 0x1A). */
    table: number;
    functions: { number: number; at: number }[];
    /** Just past the table's 0xFFFF. */
    tableEnd: number;
}

/** The text and function table, or what doesn't fit. */
export function ailLayout(data: Uint8Array): AilLayout | string {
    const word = (i: number) => data[i] | (data[i + 1] << 8);
    if (data.length < 8) return `It's ${data.length} bytes, too short for a driver.`;
    const table = word(0);
    if (table < 3 || table + 2 > data.length) return `Its first word, where the function table is, is ${table}, which isn't inside the file after the text.`;
    if (data[table - 1] !== 0x1a) return 'The text before the function table doesn’t end in 0x1A.';
    for (let i = 2; i < table - 1; i++)
        if ((data[i] < 0x20 || data[i] > 0x7e) && data[i] !== 9 && data[i] !== 10 && data[i] !== 13) return `There's a byte at ${i} in its text that isn't text (0x${data[i].toString(16)}).`;
    const functions: AilLayout['functions'] = [];
    let at = table;
    for (; at + 2 <= data.length && word(at) !== 0xffff; at += 4) {
        if (at + 4 > data.length) return 'The function table runs to the end of the file without its 0xFFFF.';
        if (functions.length >= MAX_FUNCTIONS) return `The function table goes on past ${MAX_FUNCTIONS.toLocaleString('en-US')} functions without its 0xFFFF; AIL 2 has 53.`;
        functions.push({ number: word(at), at: word(at + 2) });
    }
    if (at + 2 > data.length) return 'The function table runs to the end of the file without its 0xFFFF.';
    if (!functions.length) return 'The function table is empty.';
    return { table, functions, tableEnd: at + 2 };
}

/** By content: the layout, with function 100 (which AIL calls first, to register the driver) and every function inside the file. */
export function sniffAil(data: Uint8Array): boolean {
    const layout = ailLayout(data);
    return typeof layout !== 'string' && layout.functions.some((f) => f.number === 100) && layout.functions.every((f) => f.at >= layout.tableEnd && f.at < data.length);
}
