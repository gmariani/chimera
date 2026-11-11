import { Bytes, bytesLabel, field } from '../../core/bytes';
import type { FormatParser } from '../../core/types';
import { XCC_SIGNATURE, readLocalMixDatabase } from './names';

/**
 * XCC's "local mix database.dat": the names of the files in the MIX it sits
 * in, added by XCC Mixer so the archive can be browsed by name. A 52-byte
 * header (signature, size, type, version, count), then NUL-terminated names.
 */
const parser: FormatParser = {
    parse(data) {
        const b = new Bytes(data);
        const names = readLocalMixDatabase(data);
        if (!names) throw new Error("It doesn't start with XCC's signature.");
        let at = 52;
        const entries = names.map((name, i) => {
            const f = field(`Name ${i + 1}`, at, name.length + 1, name);
            at += name.length + 1;
            return f;
        });

        return {
            title: 'File names (XCC local mix database)',
            summary: [
                ['Names', String(names.length)],
                ['Written by', 'XCC Mixer'],
            ],
            fields: [
                {
                    name: 'Header',
                    offset: 0,
                    length: 52,
                    children: [
                        field('Signature', 0, 32, XCC_SIGNATURE),
                        field('File size', 32, 4, bytesLabel(b.u32(32))),
                        field('Type', 36, 4, b.u32(36), '0: a local mix database.'),
                        field('Version', 40, 4, b.u32(40)),
                        field('Game', 44, 4, b.u32(44), '0 TD, 1 RA, 2 TS, …'),
                        field('Name count', 48, 4, names.length),
                    ],
                },
                { name: 'Names', offset: 52, length: at - 52, children: entries },
            ],
            preview: { kind: 'text', text: names.join('\n') },
            warnings: [],
        };
    },
};

export default parser;
