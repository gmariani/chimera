import { bytesLabel, field } from '../../core/bytes';
import type { Field, FormatParser } from '../../core/types';
import { readSmf } from './smf';
import { songPreviews } from './song-preview';

/**
 * Standard MIDI files (.mid): see smf.ts. Shown as its chunks, a summary of
 * its tracks, a piano roll, and a rendering by Chimera's small synthesizer.
 */

const FORMATS = ['0: one track', '1: tracks played together', '2: tracks played apart'];
const time = (seconds: number) => {
    const s = Math.round(seconds);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const parser: FormatParser = {
    parse(data) {
        const smf = readSmf(data);
        if (typeof smf === 'string') throw new Error(`This isn't a MIDI file. ${smf}`);
        const headerSize = (data[4] << 24) | (data[5] << 16) | (data[6] << 8) | data[7];
        const division = 'ticksPerBeat' in smf.division ? `${smf.division.ticksPerBeat} ticks a beat` : `${smf.division.fps} frames a second, ${smf.division.ticksPerFrame} ticks a frame`;
        const notes = smf.song.events.filter((e) => e.status >> 4 === 0x9 && e.b > 0);
        const channels = new Set(notes.map((e) => (e.status & 15) + 1));

        const fields: Field[] = [
            {
                name: 'Header (MThd)',
                offset: 0,
                length: 8 + headerSize,
                children: [
                    field('ID', 0, 4, '"MThd"'),
                    field('Size', 4, 4, bytesLabel(headerSize), 'Big-endian, as everything in a MIDI file.'),
                    field('Format', 8, 2, FORMATS[smf.format] ?? smf.format),
                    field('Tracks', 10, 2, smf.declared),
                    field('Time', 12, 2, division, 'Ticks a beat, the beat’s length set by tempo events; or, with the top bit set, frames a second and ticks a frame.'),
                    ...(headerSize > 6 ? [field('More header', 14, headerSize - 6, bytesLabel(headerSize - 6), 'Not in the 1.0 specification; players skip it.')] : []),
                ],
            },
            ...smf.tracks.map((t, i) =>
                field(
                    `Track ${i + 1}${t.name ? `: ${JSON.stringify(t.name)}` : ''}`,
                    t.at,
                    t.length,
                    `${t.events.toLocaleString('en-US')} events`,
                    'An "MTrk" chunk: each event after a variable-length delay in ticks.'
                )
            ),
        ];

        return {
            title: 'Music (MIDI)',
            summary: [
                ['Format', FORMATS[smf.format] ?? `${smf.format}`],
                ['Tracks', `${smf.tracks.length}`],
                ['Length', time(smf.song.length)],
                [
                    'Notes',
                    `${notes.length.toLocaleString('en-US')} on ${channels.size} channel${channels.size === 1 ? '' : 's'}${channels.size ? ` (${[...channels].sort((a, b) => a - b).join(', ')})` : ''}`,
                ],
                ['Time', `${division}${smf.tempos ? `, ${smf.tempos} tempo change${smf.tempos === 1 ? '' : 's'}` : ''}`],
            ],
            fields,
            preview: { kind: 'stack', items: songPreviews(smf.song, 'The song') },
            end: smf.end,
            warnings: smf.problems,
        };
    },
};

export default parser;
