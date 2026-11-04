import { Bytes } from '../../core/bytes';

/** A CSF string table's labels and their (first) strings, for looking names up: "Name:HTNK" → "Apocalypse Tank". */
export function readCsf(data: Uint8Array): Map<string, string> {
    const b = new Bytes(data);
    const out = new Map<string, string>();
    if (b.ascii(0, 4) !== ' FSC') return out;
    let at = 24;
    for (let i = 0, count = b.u32(8); i < count && at + 12 <= data.length; i++) {
        if (b.ascii(at, 4) !== ' LBL') break;
        const pairs = b.u32(at + 4);
        const name = b.ascii(at + 12, b.u32(at + 8));
        at += 12 + name.length;
        for (let p = 0; p < pairs && at + 8 <= data.length; p++) {
            const wide = b.ascii(at, 4) === 'WRTS';
            const length = b.u32(at + 4);
            if (p === 0) {
                let text = '';
                for (let c = 0; c < length; c++) text += String.fromCharCode(~b.u16(at + 8 + c * 2) & 0xffff);
                out.set(name.toLowerCase(), text);
            }
            at += 8 + length * 2;
            if (wide) at += 4 + b.u32(at);
        }
    }
    return out;
}
