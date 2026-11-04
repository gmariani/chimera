import { bytesLabel } from '../../core/bytes';
import type { FormatParser } from '../../core/types';

/** RA2's sound banks (audio.bag): raw sound, one after another, with no headers. The .idx of the same name says where each sound is. */
const parser: FormatParser = {
    parse(data, context) {
        const index = `${(context.name ?? 'audio.bag').replace(/\.[^.]+$/, '')}.idx`;
        return {
            title: 'Sound bank data (RA2)',
            summary: [
                ['Size', bytesLabel(data.length)],
                ['Sounds', `Listed in ${index}`],
            ],
            fields: [{ name: 'Sounds', offset: 0, length: data.length, note: `Raw IMA ADPCM or PCM, back to back. ${index} has each one's name, place and format.` }],
            wanted: `Open ${index.toUpperCase()}, next to this file, to play and save the sounds by name.`,
            warnings: [],
        };
    },
};

export default parser;
