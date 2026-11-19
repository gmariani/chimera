import type { FormatParser } from '../../core/types';
import { readMenu } from '../win-menus';

/**
 * A menu saved from a Windows program's resources (see win-menus.ts): every item, its ID and how it's marked, and the
 * menu as it's laid out. It has no signature: a program says what its resources are, so it's read this way when it
 * comes from one.
 */
export function menuParser(wide: boolean): FormatParser {
    return {
        parse(data) {
            if (data.length < 6) throw new Error('This isn’t a menu: it’s too short for a menu’s header and an item.');
            const m = readMenu(data, 0, data.length, wide);
            const count = (list: typeof m.items): number => list.reduce((n, i) => n + 1 + (i.items ? count(i.items) : 0), 0);
            return {
                title: `Menu (${wide ? '32-bit' : '16-bit'}${m.extended ? ', extended' : ''} Windows resource)`,
                summary: [
                    ['Items', count(m.items).toLocaleString('en-US')],
                    ['Top level', m.items.map((i) => i.text.replace(/&(.)/g, '$1')).join(', ') || 'none'],
                ],
                fields: m.fields,
                preview: m.text ? { kind: 'text', text: m.text } : undefined,
                end: m.end,
                warnings: m.problems,
            };
        },
    };
}

export default menuParser(true);
