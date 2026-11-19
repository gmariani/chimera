import type { FormatParser } from '../core/types';
import { readDos16m } from './dos16m';
import { sniffDos16mModule } from './dos16m-sniff';

/**
 * A DOS/16M module saved on its own (.EXP): one of the DOS/4GW extender's modules, as they're bound into a program
 * after its DOS loader (VMM.EXP, 4GWPRO.EXP, CFG4GPRO.EXP). Its header is read field by field; what follows it, the
 * module's descriptor table, code and data, isn't. See dos16m.ts.
 */
const parser: FormatParser = {
    parse(data, context) {
        if (!sniffDos16mModule(data)) throw new Error('This isn’t a DOS/16M module: it doesn’t start with "BW" and a header naming an .EXP file.');
        const m = readDos16m(data, 0, (context.name ?? 'module').replace(/\.[^.]*$/, ''), { alone: true })!;
        const field = m.fields[0];
        return {
            title: 'DOS extender module (DOS/16M)',
            summary: [
                ['Name', m.modules[0]],
                ['What', field.value ?? ''],
            ],
            fields: m.fields,
            end: m.end,
            warnings: m.problems,
        };
    },
};

export default parser;
