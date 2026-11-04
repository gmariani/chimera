import { Bytes, bytesLabel, field } from '../../core/bytes';
import type { FormatParser } from '../../core/types';

/**
 * Bink video (RAD Game Tools), which RA2 uses for its movies. Only the header
 * is read here: Bink's codec isn't public, so the frames aren't decoded.
 */
const parser: FormatParser = {
    parse(data) {
        const b = new Bytes(data);
        if (b.ascii(0, 3) !== 'BIK') throw new Error('No "BIK" header.');
        const [frames, width, height, dividend, divider, tracks] = [b.u32(8), b.u32(20), b.u32(24), b.u32(28), b.u32(32), b.u32(40)];
        const fps = divider ? dividend / divider : 0;
        // Per track: a maximum packet size, then (after all of those) rate and flags, then (after those) an ID.
        const audio = 44 + tracks * 4;
        return {
            title: 'Bink video (header only)',
            summary: [
                ['Version', b.ascii(3, 1)],
                ['Size', `${width} × ${height}`],
                ['Frames', `${frames} at ${+fps.toFixed(3)} per second (${fps ? (frames / fps).toFixed(1) : '?'} s)`],
                ['Sound tracks', String(tracks)],
                ['Preview', 'None: Bink\'s codec isn\'t public. Save the file and play it with RAD\'s tools or ffmpeg.'],
            ],
            fields: [
                {
                    name: 'Header',
                    offset: 0,
                    length: 44,
                    children: [
                        field('ID', 0, 3, 'BIK'),
                        field('Version', 3, 1, b.ascii(3, 1)),
                        field('Size', 4, 4, bytesLabel(b.u32(4)), 'Of everything after this field.'),
                        field('Frames', 8, 4, frames),
                        field('Largest frame', 12, 4, bytesLabel(b.u32(12))),
                        field('Frames (again)', 16, 4, b.u32(16)),
                        field('Width', 20, 4, width),
                        field('Height', 24, 4, height),
                        field('Frame rate dividend', 28, 4, dividend),
                        field('Frame rate divider', 32, 4, divider),
                        field('Flags', 36, 4, `0x${b.u32(36).toString(16)}`),
                        field('Sound tracks', 40, 4, tracks),
                    ],
                },
                ...Array.from({ length: Math.min(tracks, 16) }, (_, i) => {
                    const at = audio + i * 4;
                    const rate = b.u16(at);
                    const flags = b.u16(at + 2);
                    return field(`Track ${i} format`, at, 4, `${rate} Hz${flags & 0x2000 ? ', stereo' : ''}${flags & 0x1000 ? ', DCT' : ', RDFT'}`);
                }),
                field('Frame index', 44 + tracks * 12, (frames + 1) * 4, `${frames + 1} offsets`, 'Where each frame starts; bit 0 marks a keyframe.'),
            ],
            warnings: [],
        };
    },
};

export default parser;
