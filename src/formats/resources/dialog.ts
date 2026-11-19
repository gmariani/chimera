import type { FormatParser } from '../../core/types';
import { readDialog } from '../win-dialogs';

/**
 * A dialog box saved from a 16-bit Windows module's resources (see win-dialogs.ts): drawn as it's laid out, every
 * control named. It has no signature: the module says what its resources are, so it's read this way when it comes from
 * one. The icons and bitmaps it shows are the module's, so on its own they're named, not drawn. (A 32-bit program's
 * dialogs are saved as .res files instead, with their pictures: see res.ts.)
 */
export function dialogParser(wide: boolean): FormatParser {
    return {
        parse(data) {
            const d = readDialog(data, 0, data.length, wide);
            if (!d) throw new Error('This isn’t a dialog: it’s too short for a dialog’s header.');
            const { preview } = d;
            const counts = new Map<string, number>();
            for (const c of preview.controls) counts.set(c.className, (counts.get(c.className) ?? 0) + 1);
            return {
                title: `Dialog (${d.layout} Windows resource)`,
                summary: [
                    ['Title', preview.title || '(none)'],
                    ['Size', `${preview.width} × ${preview.height} dialog units, about ${Math.round(preview.width * preview.units[0])} × ${Math.round(preview.height * preview.units[1])} pixels`],
                    ['Font', preview.font.name ? `${preview.font.name}, ${preview.font.size} point` : 'the system’s'],
                    ['Controls', [...counts].map(([k, n]) => `${n} ${k}`).join(', ') || 'none'],
                ],
                fields: d.fields,
                preview,
                end: d.end,
                warnings: d.problems,
            };
        },
    };
}

export default dialogParser(false);
