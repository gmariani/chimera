import { bytesLabel, field } from '../../core/bytes';
import type { Field, FormatParser, TableRow } from '../../core/types';
import { sniffInstallShieldScript } from './sniff';

/**
 * InstallShield's compiled scripts (SETUP.INS), from versions 2 to 5: what the setup engine (_INST32I.EX_) runs to
 * install a program. Counterstrike's Windows installers each have one, made by InstallShield 3.
 *
 * InstallShield never published the format. This follows Andrew de Quincey's isDcc 1.22, a decompiler for these
 * scripts (https://github.com/incognitte/isDcc): the signature, the version, a checksum, a notice; how many labels
 * the code has; a word for each string variable; the system's string and number variables by name; the structures
 * the script declares; its functions, its own and those it calls in DLLs; then its code, and the compiler's version
 * at the very end, its length in the last byte. What isDcc leaves unnamed is read from Counterstrike's three and ten
 * other programs' (seven from InstallShield 3, three from 5) collected for the Just Solve the File Format Problem
 * wiki (https://sembiance.com/fileFormatSamples/other/installShieldScript/): the checksum is the sum of every byte
 * after it, and the word for each string variable is 512 for the system's and, for the script's own, what looks like
 * the size each is declared with (65,535 when none is given).
 *
 * The code isn't taken apart: Chimera explains files, and isn't a decompiler. What the script calls in DLLs is listed,
 * since that's what it can do beyond InstallShield's own functions.
 */

/** Version numbers isDcc knows, and what they are. 3.00.065's and 5.00.000's scripts have been read here; 2.20.905's haven't. */
const VERSIONS: Record<number, string> = { 0x1234001c: '2.20.905', 0x12340016: '3.00.065', 0x00010050: '5.00.000' };
const CHECKED = new Set([0x12340016, 0x00010050]);
/** isDcc's names for the types of variables, members and parameters. */
const TYPES = ['string', 'char', 'long', 'int', 'number', 'list', 'bool', 'hwnd'];
/** Kinds of function. */
const DLL = 1;
const OWN = 2;

/** The bytes ran out before a table did. */
class Cut extends Error {}

const parser: FormatParser = {
    parse(data) {
        if (!sniffInstallShieldScript(data)) throw new Error("This isn't an InstallShield script: it doesn't start with B8 C9 0C 00.");
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const latin1 = (from: number, length: number) => new TextDecoder('latin1').decode(data.subarray(from, from + length));
        const warnings: string[] = [];
        let at = 0;
        const need = (n: number) => {
            if (at + n > data.length) throw new Cut();
        };
        const u16 = () => {
            need(2);
            at += 2;
            return view.getUint16(at - 2, true);
        };
        const u32 = () => {
            need(4);
            at += 4;
            return view.getUint32(at - 4, true);
        };
        const typeName = (t: number) => TYPES[t] ?? `type ${t}`;
        const unknownTypes = new Set<number>();
        const typeField = (name: string, from: number, t: number) => {
            if (TYPES[t] === undefined) unknownTypes.add(t);
            return field(name, from, 2, typeName(t), TYPES[t] === undefined ? 'Not a type isDcc knows.' : undefined);
        };
        /** A name with a 16-bit length before it: its fields, and the name. */
        const name16 = (what: string): { name: string; fields: Field[] } => {
            const from = at;
            const n = u16();
            need(n);
            at += n;
            const text = latin1(from + 2, n);
            return { name: text, fields: [field(`${what} length`, from, 2, n), ...(n ? [field(what, from + 2, n, text)] : [])] };
        };

        // The compiler's version, at the end: its length in the last byte.
        const length = data[data.length - 1];
        const compiler = data.length > length + 1 ? latin1(data.length - 1 - length, length) : '';
        const versioned = /^\d+\.\d+\.\d+$/.test(compiler);
        const codeEnd = versioned ? data.length - 1 - length : data.length;
        if (!versioned) warnings.push("The file doesn't end with the version of the compiler that made it, as InstallShield's scripts do: it may be cut short, or have something after it.");

        const fields: Field[] = [];
        const rows: TableRow[] = [];
        const counts = { systemStrings: 0, ownStrings: 0, systemNumbers: 0, ownNumbers: 0, structures: 0, own: 0, dll: 0 };
        const dlls = new Set<string>();
        let section = 'header';
        let codeStart = -1;
        let version = 0;
        try {
            at = 4;
            version = u32();
            const checksum = u32();
            const notice = data[at];
            at++;
            need(notice);
            const text = latin1(13, notice);
            at += notice;
            const sum = data.subarray(12).reduce((n, v) => n + v, 0) >>> 0;
            if (checksum !== sum)
                warnings.push(
                    `The checksum is ${checksum.toLocaleString('en-US')}, but the bytes after it add up to ${sum.toLocaleString('en-US')}: the script has been changed, or damaged, since it was compiled.`
                );
            if (!CHECKED.has(version))
                warnings.push(
                    `This script says it's for InstallShield ${VERSIONS[version] ?? `0x${version.toString(16)}, a version isDcc doesn't know`}. Only 3.00.065's and 5.00.000's have been checked here, so it may be read wrongly.`
                );
            fields.push({
                name: 'Header',
                offset: 0,
                length: at,
                children: [
                    field('Signature', 0, 4, 'B8 C9 0C 00'),
                    field(
                        'Version',
                        4,
                        4,
                        VERSIONS[version] ?? `0x${version.toString(16)}`,
                        VERSIONS[version] ? `The format's version, InstallShield ${VERSIONS[version]}'s (0x${version.toString(16)}).` : 'Not one isDcc knows.'
                    ),
                    field(
                        'Checksum',
                        8,
                        4,
                        checksum.toLocaleString('en-US'),
                        checksum === sum ? 'The sum of every byte after it: it matches.' : `The sum of every byte after it, which is ${sum.toLocaleString('en-US')}.`
                    ),
                    field('Notice length', 12, 1, notice),
                    ...(notice ? [field('Notice', 13, notice, text.trim())] : []),
                ],
            });

            section = 'labels';
            const labelsAt = at;
            const labels = u16();
            fields.push(field('Labels', labelsAt, 2, labels, `Places in the code that jumps go to, numbered from 0: ${(labels + 1).toLocaleString('en-US')} of them.`));

            // A word for each string variable, then the system's by name.
            section = 'string variables';
            const stringsAt = at;
            const stringCount = u16();
            need(stringCount * 2);
            const sizesAt = at;
            at += stringCount * 2;
            const systemAt = at;
            const systemCount = u16();
            const sizeOf = (i: number) => view.getUint16(sizesAt + i * 2, true);
            const size = (v: number) => (v === 0xffff ? 'none given' : v.toLocaleString('en-US'));
            const systemFields: Field[] = [];
            const systemNames: string[] = [];
            for (let i = 0; i < systemCount; i++) {
                const from = at;
                const number = u16();
                const n = name16('Name');
                systemNames.push(n.name);
                if (number !== i) warnings.push(`The system string variable ${n.name} is numbered ${number}, but it's number ${i} in the list.`);
                systemFields.push({ name: n.name, offset: from, length: at - from, children: [field('Number', from, 2, number), ...n.fields] });
                rows.push({ group: 'System variables', cells: { name: n.name, kind: 'string', details: i < stringCount ? `size ${size(sizeOf(i))}` : '' } });
            }
            if (systemCount > stringCount) warnings.push(`There are ${systemCount} system string variables, but words for only ${stringCount} string variables in all.`);
            counts.systemStrings = systemCount;
            counts.ownStrings = Math.max(0, stringCount - systemCount);
            fields.push({
                name: 'String variables',
                offset: stringsAt,
                length: at - stringsAt,
                value: `${systemCount} the system's, ${counts.ownStrings.toLocaleString('en-US')} the script's own`,
                children: [
                    field('Count', stringsAt, 2, stringCount, 'The system’s and the script’s own.'),
                    {
                        name: 'Sizes',
                        offset: sizesAt,
                        length: stringCount * 2,
                        children: Array.from({ length: stringCount }, (_, i) =>
                            field(
                                i < systemCount ? (systemNames[i] ?? `String ${i + 1}`) : `String ${i + 1} (the script's own)`,
                                sizesAt + i * 2,
                                2,
                                size(sizeOf(i)),
                                i === 0 ? 'What looks like the size each is declared with (65,535: none given); isDcc only says these are to do with setting the strings up.' : undefined
                            )
                        ),
                    },
                    field('System variables', systemAt, 2, systemCount),
                    ...systemFields,
                ],
            });

            section = 'number variables';
            const numbersAt = at;
            const numberCount = u16();
            const systemNumbers = u16();
            const numberFields: Field[] = [];
            for (let i = 0; i < systemNumbers; i++) {
                const from = at;
                const number = u16();
                const n = name16('Name');
                if (number !== i) warnings.push(`The system number variable ${n.name} is numbered ${number}, but it's number ${i} in the list.`);
                numberFields.push({ name: n.name, offset: from, length: at - from, children: [field('Number', from, 2, number), ...n.fields] });
                rows.push({ group: 'System variables', cells: { name: n.name, kind: 'number', details: '' } });
            }
            if (systemNumbers > numberCount) warnings.push(`There are ${systemNumbers} system number variables, but only ${numberCount} number variables in all.`);
            counts.systemNumbers = systemNumbers;
            counts.ownNumbers = Math.max(0, numberCount - systemNumbers);
            fields.push({
                name: 'Number variables',
                offset: numbersAt,
                length: at - numbersAt,
                value: `${systemNumbers} the system's, ${counts.ownNumbers.toLocaleString('en-US')} the script's own`,
                children: [field('Count', numbersAt, 2, numberCount, 'The system’s and the script’s own.'), field('System variables', numbersAt + 2, 2, systemNumbers), ...numberFields],
            });

            section = 'structures';
            const structuresAt = at;
            const structureCount = u16();
            const structureFields: Field[] = [];
            for (let i = 0; i < structureCount; i++) {
                const from = at;
                const unknown = u16();
                const n = name16('Name');
                const membersAt = at;
                const memberCount = u16();
                const members: Field[] = [];
                const described: string[] = [];
                for (let j = 0; j < memberCount; j++) {
                    const m = at;
                    const [type, bytes] = [u16(), u16()];
                    const mn = name16('Name');
                    described.push(`${typeName(type)} ${mn.name}`);
                    members.push({
                        name: mn.name,
                        offset: m,
                        length: at - m,
                        value: typeName(type),
                        children: [typeField('Type', m, type), field('Size', m + 2, 2, bytes, 'As isDcc names it; the same as the type’s number in every one seen.'), ...mn.fields],
                    });
                }
                structureFields.push({
                    name: n.name,
                    offset: from,
                    length: at - from,
                    value: `${memberCount} member${memberCount === 1 ? '' : 's'}`,
                    children: [field('Not known', from, 2, unknown, '0 in every one seen.'), ...n.fields, field('Members', membersAt, 2, memberCount), ...members],
                });
                rows.push({ group: 'Structures', cells: { name: n.name, kind: 'structure', details: described.join(', ') } });
            }
            counts.structures = structureCount;
            fields.push({
                name: 'Structures',
                offset: structuresAt,
                length: at - structuresAt,
                value: String(structureCount),
                children: [field('Count', structuresAt, 2, structureCount), ...structureFields],
            });

            section = 'functions';
            const functionsAt = at;
            const functionCount = u16();
            const functionFields: Field[] = [];
            const parameters = (): { fields: Field[]; text: string } => {
                const from = at;
                const n = u16();
                const out: Field[] = [field('Parameters', from, 2, n)];
                const text: string[] = [];
                for (let k = 0; k < n; k++) {
                    const p = at;
                    const [type, flags] = [u16(), u16()];
                    const byRef = (flags & 2) !== 0;
                    text.push(`${byRef ? 'BYREF ' : ''}${typeName(type)}`);
                    out.push({
                        name: `Parameter ${k + 1}`,
                        offset: p,
                        length: 4,
                        value: typeName(type),
                        children: [typeField('Type', p, type), field('Flags', p + 2, 2, `0x${flags.toString(16).padStart(4, '0')}`, byRef ? 'Passed by reference (0x2).' : 'Passed by value.')],
                    });
                }
                return { fields: out, text: text.join(', ') || 'none' };
            };
            for (let i = 0; i < functionCount; i++) {
                const from = at;
                const kind = u16();
                if (kind === OWN) {
                    need(6);
                    const blank = data.subarray(at, at + 6).every((v) => v === 0);
                    const unknownAt = at;
                    at += 6;
                    const p = parameters();
                    counts.own++;
                    functionFields.push({
                        name: `Function ${counts.own}`,
                        offset: from,
                        length: at - from,
                        value: 'the script’s own',
                        children: [
                            field('Kind', from, 2, kind, 'The script’s own (2).'),
                            field(
                                'Not known',
                                unknownAt,
                                6,
                                blank ? 'zeros' : Array.from(data.subarray(unknownAt, unknownAt + 6), (v) => v.toString(16).padStart(2, '0')).join(' '),
                                'Zeros in every one seen.'
                            ),
                            ...p.fields,
                        ],
                    });
                    rows.push({ group: 'The script’s functions', cells: { name: `Function ${counts.own}`, kind: 'own', details: `parameters: ${p.text}` } });
                } else if (kind === DLL) {
                    const returnsAt = at;
                    const returns = u16();
                    const library = name16('DLL');
                    const fn = name16('Function');
                    const p = parameters();
                    counts.dll++;
                    dlls.add(library.name.toUpperCase());
                    functionFields.push({
                        name: `${library.name}.${fn.name}`,
                        offset: from,
                        length: at - from,
                        value: 'in a DLL',
                        children: [field('Kind', from, 2, kind, 'In a DLL (1).'), typeField('Returns', returnsAt, returns), ...library.fields, ...fn.fields, ...p.fields],
                    });
                    rows.push({ group: 'Imported from DLLs', cells: { name: `${library.name}.${fn.name}`, kind: `returns ${typeName(returns)}`, details: `parameters: ${p.text}` } });
                } else {
                    warnings.push(`Function ${i + 1} of ${functionCount} is of kind ${kind}, which isn't one known (1 is a DLL's, 2 the script's own): the functions can't be read past it.`);
                    at = from;
                    throw new Cut();
                }
            }
            fields.push({
                name: 'Functions',
                offset: functionsAt,
                length: at - functionsAt,
                value: `${counts.own} the script's own, ${counts.dll} in DLLs`,
                children: [field('Count', functionsAt, 2, functionCount), ...functionFields],
            });

            section = 'end of the tables';
            const lastAt = at;
            const last = u16();
            fields.push(field('Not known', lastAt, 2, last, '0 in every one seen; isDcc skips it too.'));
            codeStart = at;
        } catch (e) {
            if (!(e instanceof Cut)) throw e;
            if (!fields.length) throw new Error('This InstallShield script is cut short: it ends inside its header.');
            if (!warnings.some((w) => w.includes("can't be read past it"))) warnings.push(`The file ends inside the ${section}: the rest isn't read.`);
            const from = fields.reduce((n, f) => Math.max(n, f.offset + f.length), 0);
            if (from < codeEnd) fields.push(field('Not read', from, codeEnd - from, bytesLabel(codeEnd - from), `From the ${section} on, which couldn't be read.`));
        }
        if (unknownTypes.size) warnings.push(`Some types aren't ones isDcc knows: ${[...unknownTypes].join(', ')}.`);

        if (codeStart >= 0) {
            if (codeStart > codeEnd) warnings.push('The tables run into where the compiler’s version is, at the end.');
            else fields.push(field('Code', codeStart, codeEnd - codeStart, bytesLabel(codeEnd - codeStart), 'The script’s instructions, which Chimera doesn’t take apart.'));
        }
        if (versioned) fields.push(field('Compiler', codeEnd, length, compiler, 'The version of InstallShield’s compiler that made it.'), field('Compiler length', data.length - 1, 1, length));

        const versionName = VERSIONS[version] ?? `0x${version.toString(16)}`;
        return {
            title: 'InstallShield script',
            summary: [
                ['Version', `InstallShield ${versionName}${versioned ? `, compiled with ${compiler}` : ''}`],
                ['Functions', `${counts.own.toLocaleString('en-US')} its own, ${counts.dll.toLocaleString('en-US')} in DLLs${dlls.size ? ` (${[...dlls].join(', ')})` : ''}`],
                [
                    'Variables',
                    `${(counts.systemStrings + counts.systemNumbers).toLocaleString('en-US')} the system's; ${counts.ownStrings.toLocaleString('en-US')} strings and ${counts.ownNumbers.toLocaleString('en-US')} numbers its own`,
                ],
                ...(codeStart >= 0 && codeStart <= codeEnd ? [['Code', bytesLabel(codeEnd - codeStart)] as [string, string]] : []),
            ],
            fields: fields.sort((a, b) => a.offset - b.offset),
            preview: {
                kind: 'table',
                columns: [
                    { key: 'name', label: 'Name' },
                    { key: 'kind', label: 'Kind' },
                    { key: 'details', label: 'Details' },
                ],
                groups: ['Imported from DLLs', 'The script’s functions', 'Structures', 'System variables'].filter((g) => rows.some((r) => r.group === g)),
                rows,
            },
            end: data.length,
            warnings,
        };
    },
};

export default parser;
