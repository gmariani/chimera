import { bytesLabel, field, hex } from '../core/bytes';
import type { Field, FormatParser } from '../core/types';

/**
 * Pixel Bender kernels (PBJ), the compiled filters Flash Player 10 runs on
 * pictures. Records, each starting with a byte: the version (A5), the name
 * (A4), metadata (A0), parameters (A1) and their metadata (A2), input
 * textures (A3); then instructions of 8 bytes: an opcode, a destination
 * register and write mask, and a source register and swizzle. Integers are
 * little-endian; float constants are big-endian.
 */

const TYPES: Record<number, [string, number]> = {
    0x01: ['float', 1],
    0x02: ['float2', 2],
    0x03: ['float3', 3],
    0x04: ['float4', 4],
    0x05: ['float2x2', 4],
    0x06: ['float3x3', 9],
    0x07: ['float4x4', 16],
    0x08: ['int', 1],
    0x09: ['int2', 2],
    0x0a: ['int3', 3],
    0x0b: ['int4', 4],
    0x0c: ['string', 0],
};

const OPCODES = [
    'nop', 'add', 'sub', 'mul', 'rcp', 'div', 'atan2', 'pow', 'mod', 'min', 'max', 'step', 'sin', 'cos', 'tan', 'asin',
    'acos', 'atan', 'exp', 'exp2', 'log', 'log2', 'sqrt', 'rsqrt', 'abs', 'sign', 'floor', 'ceil', 'fract', 'mov', 'ftoi', 'itof',
    'matmatmul', 'vecmatmul', 'matvecmul', 'normalize', 'length', 'distance', 'dot', 'cross', 'equal', 'notEqual', 'lessThan', 'lessThanEqual', 'logicalNot', 'logicalAnd', 'logicalOr', 'logicalXor',
    'sampleNearest', 'sampleLinear', 'load', 'loop', 'if', 'else', 'endif', 'ftob', 'btof', 'itob', 'btoi', 'vectorEqual', 'vectorNotEqual', 'any', 'all', 'select',
]; // prettier-ignore

const RECORDS: Record<number, string> = { 0xa0: 'Kernel metadata', 0xa1: 'Parameter', 0xa2: 'Parameter metadata', 0xa3: 'Texture', 0xa4: 'Name', 0xa5: 'Version' };

/** A register: f0, f1… for floats, i0… for ints (the top bit of the number). */
const register = (r: number) => (r & 0x8000 ? `i${r & 0x7fff}` : `f${r}`);
/** A write mask (x 8, y 4, z 2, w 1) as letters. */
const maskLetters = (m: number) => ['x', 'y', 'z', 'w'].filter((_, i) => m & (8 >> i)).join('');
/** A swizzle: 2 bits a component, the first highest. */
const swizzle = (s: number, size: number) => Array.from({ length: size }, (_, i) => 'xyzw'[(s >> (6 - i * 2)) & 3]).join('');

const parser: FormatParser = {
    parse(data) {
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const fields: Field[] = [];
        const warnings: string[] = [];
        const lines: string[] = [];
        const meta = new Map<string, string>();
        const params: string[] = [];
        const textures: string[] = [];
        let name = '';
        let version = 0;
        let at = 0;

        const cString = (from: number) => {
            let end = from;
            while (end < data.length && data[end]) end++;
            return { text: new TextDecoder().decode(data.subarray(from, end)), next: end + 1 };
        };
        /** A typed value: floats (big-endian), ints (16-bit), or a string. */
        const value = (type: number, from: number): { text: string; next: number } => {
            if (type === 0x0c) return cString(from);
            const [, count] = TYPES[type] ?? ['?', 0];
            const floats = type <= 0x07;
            const values = Array.from({ length: count }, (_, i) => (floats ? +view.getFloat32(from + i * 4, false).toPrecision(6) : view.getUint16(from + i * 2, true)));
            return { text: count === 1 ? String(values[0]) : `(${values.join(', ')})`, next: from + count * (floats ? 4 : 2) };
        };

        // The records before the code.
        while (at < data.length && data[at] >= 0xa0 && data[at] <= 0xa5) {
            const start = at;
            const op = data[at];
            const children: Field[] = [field('Record type', at, 1, `0x${hex(op, 2)}`)];
            let shown = '';
            if (op === 0xa5) {
                version = view.getUint32(at + 1, true);
                children.push(field('Version', at + 1, 4, version));
                shown = String(version);
                at += 5;
            } else if (op === 0xa4) {
                const length = view.getUint16(at + 1, true);
                name = new TextDecoder().decode(data.subarray(at + 3, at + 3 + length));
                children.push(field('Length', at + 1, 2, length), field('Name', at + 3, length, name));
                shown = name;
                at += 3 + length;
            } else if (op === 0xa0 || op === 0xa2) {
                const type = data[at + 1];
                const key = cString(at + 2);
                const v = value(type, key.next);
                children.push(field('Type', at + 1, 1, TYPES[type]?.[0] ?? `0x${hex(type, 2)}`), field('Key', at + 2, key.next - at - 2, key.text), field('Value', key.next, v.next - key.next, v.text));
                if (op === 0xa0) meta.set(key.text, v.text);
                else params[params.length - 1] += `\n    ${key.text}: ${v.text}`;
                shown = `${key.text}: ${v.text}`;
                at = v.next;
            } else if (op === 0xa1) {
                const qualifier = data[at + 1];
                const type = data[at + 2];
                const reg = view.getUint16(at + 3, true);
                const mask = data[at + 5];
                const n = cString(at + 6);
                // Matrices take whole registers; the mask holds their size instead.
                const where = type >= 0x05 && type <= 0x07 ? register(reg) : `${register(reg)}.${maskLetters(mask)}`;
                children.push(field('Qualifier', at + 1, 1, qualifier === 2 ? 'Out' : 'In'), field('Type', at + 2, 1, TYPES[type]?.[0] ?? `0x${hex(type, 2)}`), field('Register', at + 3, 2, register(reg)), field('Mask', at + 5, 1, maskLetters(mask) || `0x${hex(mask, 2)}`), field('Name', at + 6, n.next - at - 6, n.text));
                shown = `${qualifier === 2 ? 'out' : 'in'} ${TYPES[type]?.[0] ?? '?'} ${n.text} (${where})`;
                params.push(shown);
                at = n.next;
            } else {
                const n = cString(at + 3);
                children.push(field('Index', at + 1, 1, data[at + 1]), field('Channels', at + 2, 1, data[at + 2]), field('Name', at + 3, n.next - at - 3, n.text));
                shown = `${n.text} (texture ${data[at + 1]}, ${data[at + 2]} channels)`;
                textures.push(shown);
                at = n.next;
            }
            fields.push({ name: RECORDS[op], offset: start, length: at - start, value: shown, children });
        }

        // The code: 8-byte instructions.
        const code: Field[] = [];
        const codeStart = at;
        let indent = 1;
        for (; at + 8 <= data.length; at += 8) {
            const op = data[at];
            const name_ = OPCODES[op] ?? `op 0x${hex(op, 2)}`;
            const dst = view.getUint16(at + 1, true);
            const mask = data[at + 3];
            const dstMask = mask >> 4;
            const size = (mask & 3) + 1;
            const matrix = (mask >> 2) & 3;
            const src = data[at + 4] | (data[at + 5] << 8);
            const sw = data[at + 6];
            const out = `${register(dst)}${dstMask ? `.${maskLetters(dstMask)}` : ''}`;
            const source = `${register(src)}${matrix ? '' : `.${swizzle(sw, size)}`}`;
            let text: string;
            if (op === 0x32) {
                // A constant (big-endian, int or float) where the source would be.
                const constant = dst & 0x8000 ? view.getInt32(at + 4, false) : +view.getFloat32(at + 4, false).toPrecision(6);
                text = `${out} = ${constant}`;
            } else if (op === 0x30 || op === 0x31) {
                text = `${out} = ${name_}(texture ${data[at + 7]}, ${register(src)}.${swizzle(sw, 2)})`;
            } else if (op === 0x34) {
                text = `if (${register(src)}.${swizzle(sw, 1)})`;
            } else if (op === 0x35 || op === 0x36) {
                text = name_;
            } else if (op === 0x1d) {
                text = `${out} = ${source}`;
            } else {
                text = `${out} = ${name_}(${out}, ${source})`;
                if ([0x04, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1e, 0x1f, 0x23, 0x24, 0x2c, 0x37, 0x38, 0x39, 0x3a, 0x3d, 0x3e].includes(op)) text = `${out} = ${name_}(${source})`;
            }
            if (op === 0x35 || op === 0x36) indent--;
            lines.push(`${'    '.repeat(Math.max(1, indent))}${text}`);
            if (op === 0x34 || op === 0x35) indent++;
            code.push(field(`${code.length + 1}: ${name_}`, at, 8, text));
            if (!OPCODES[op]) warnings.push(`Unknown opcode 0x${hex(op, 2)} at ${at}.`);
        }
        if (code.length) fields.push({ name: 'Code', offset: codeStart, length: at - codeStart, value: `${code.length} instructions`, children: code });
        if (at < data.length) fields.push(field('Left over', at, data.length - at, bytesLabel(data.length - at)));

        const text = [
            `kernel ${name}`,
            ...[...meta].map(([k, v]) => `    ${k}: ${v}`),
            '',
            ...textures.map((t) => `input image ${t}`),
            ...params.map((p) => `parameter ${p}`),
            '',
            'evaluatePixel() {',
            ...lines,
            '}',
        ].join('\n');
        return {
            title: 'Pixel Bender kernel (PBJ)',
            summary: [
                ['Name', name],
                ['Bytecode version', String(version)],
                ...[...meta].map(([k, v]) => [k[0].toUpperCase() + k.slice(1), v] as [string, string]),
                ['Inputs', String(textures.length)],
                ['Parameters', String(params.length)],
                ['Instructions', String(code.length)],
            ],
            fields,
            preview: { kind: 'text', text },
            warnings,
        };
    },
};

export default parser;
