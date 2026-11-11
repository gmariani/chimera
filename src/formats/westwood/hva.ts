import { Bytes, field } from '../../core/bytes';
import type { FormatParser } from '../../core/types';
import { hvaLayout } from './sniff';

/**
 * TS and RA2 voxel animations (.hva), which move the limbs of the voxel model
 * of the same name: a name, the frame and section (limb) counts, each
 * section's name, then for each frame a 3 × 4 transform per section.
 */
const parser: FormatParser = {
    parse(data) {
        const layout = hvaLayout(data);
        if (!layout) throw new Error("The counts don't match the size of the file.");
        const b = new Bytes(data);
        const { frames, sections } = layout;
        const names = Array.from({ length: sections }, (_, i) => b.asciiz(24 + i * 16).text.slice(0, 16));
        const matrices = 24 + sections * 16;
        const row = (at: number) => [0, 1, 2, 3].map((i) => +b.f32(at + i * 4).toFixed(3)).join(', ');

        return {
            title: 'Voxel animation (HVA)',
            summary: [
                ['Frames', String(frames)],
                ['Sections', names.join(', ')],
            ],
            fields: [
                field('Name', 0, 16, b.asciiz(0).text.slice(0, 16), "Where the file was on the artist's machine; unused."),
                field('Frames', 16, 4, frames),
                field('Sections', 20, 4, sections),
                { name: 'Section names', offset: 24, length: sections * 16, children: names.map((n, i) => field(`Section ${i}`, 24 + i * 16, 16, n)) },
                ...Array.from({ length: Math.min(frames, 500) }, (_, f) => ({
                    name: `Frame ${f}`,
                    offset: matrices + f * sections * 48,
                    length: sections * 48,
                    children: names.map((n, s) => {
                        const at = matrices + (f * sections + s) * 48;
                        return field(n, at, 48, `[${row(at)}] [${row(at + 16)}] [${row(at + 32)}]`, 'Rotation and scale in the first three columns, position in the last.');
                    }),
                })),
            ],
            warnings: [],
        };
    },
};

export default parser;
