import { field } from '../../core/bytes';
import type { Field, FormatParser, Parsed } from '../../core/types';
import { duneCfgValues, sniffDuneCfg, sniffDuneOptions } from './sniff';

/**
 * Dune II's two settings files, both 10 bytes.
 *
 * DUNE.CFG, which SETUP.EXE writes: the graphics, the sound drivers for
 * music, effects and voices (each a number in the game's own lists), whether
 * to use the mouse and extended memory, two bytes nothing is known to read,
 * the language, and a checksum. The first 8 are lightly hidden: each is
 * stored as (value + n) XOR 0xA5, n counting down from 7 (OpenDUNE's
 * Config_Read, src/config.c). Without a good one the game won't start: "The
 * setup program must be run first."
 *
 * OPTIONS.CFG, which the game writes from its options screen: music,
 * sounds, game speed, hints and auto-scroll, a 16-bit number each
 * (GameOptions_Load).
 *
 * The driver lists are DUNE2.EXE's own (OpenDUNE's MSDriver and DSDriver
 * tables, from before it replaced the drivers): each entry names the driver
 * and the extension of the music it plays. https://github.com/OpenDUNE/OpenDUNE
 */

/** The music and sound-effect drivers, by number: the file, the music it plays, and the card. */
const MUSIC_DRIVERS: [string, string, string][] = [
    ['', '', 'None'],
    ['ALFX.DRV', 'ADL', 'AdLib or Sound Blaster, through Westwood’s own player'],
    ['PCSOUND.DRV', 'PCS', 'PC speaker, through Westwood’s own driver'],
    ['PCSOUND.DRV', 'PCS', 'PC speaker, through Westwood’s own driver (its second setting)'],
    ['PCSPKR.ADV', 'PCS', 'PC speaker, through Miles’s driver'],
    ['TANDY.ADV', 'TAN', 'Tandy 3-voice sound'],
    ['MT32MPU.ADV', 'XMI', 'Roland MT-32 or LAPC-1'],
    ['MT32MPU.ADV', 'C55', 'Roland Sound Canvas (SC-55)'],
    ['ADLIB.ADV', 'ADL', 'AdLib, through Miles’s driver'],
    ['ADLIBG.ADV', 'ADL', 'AdLib Gold, through Miles’s driver'],
    ['PASFM.ADV', 'ADL', 'Pro Audio Spectrum FM, through Miles’s driver'],
    ['SBFM.ADV', 'ADL', 'Sound Blaster FM, through Miles’s driver'],
    ['SBP1FM.ADV', 'ADL', 'Sound Blaster Pro FM, through Miles’s driver'],
    ['SBP2FM.ADV', 'ADL', 'Sound Blaster Pro 2 FM, through Miles’s driver'],
];
/** The digitized-voice drivers, by number. */
const VOICE_DRIVERS: [string, string][] = [
    ['', 'None'],
    ['SBDIG.ADV', 'Sound Blaster'],
    ['SBPDIG.ADV', 'Sound Blaster Pro'],
    ['PASDIG.ADV', 'Pro Audio Spectrum'],
    ['ALGDIG.ADV', 'AdLib Gold'],
    ['IBMBAK.COM', 'IBMBAK.COM (not shipped with the game)'],
    ['ADLIB.COM', 'ADLIB.COM (not shipped with the game)'],
];
const LANGUAGES = ['English', 'French', 'German', 'Italian', 'Spanish'];
const SPEEDS = ['Slowest', 'Slow', 'Normal', 'Fast', 'Fastest'];
const onOff = (v: number) => (v === 1 ? 'On' : v === 0 ? 'Off' : `${v}`);

function duneCfg(data: Uint8Array): Parsed {
    const { values, checksum } = duneCfgValues(data)!;
    const [graphics, music, sound, voice, mouse, xms, unknown6, unknown7] = values;
    const language = data[8];
    const warnings: string[] = [];
    if (checksum !== data[9]) warnings.push(`The checksum is ${data[9]}, but the settings add up to ${checksum}: Dune II won't start ("The setup program must be run first").`);
    // DUNE2.EXE's start-up switches on the graphics value less 7, over 6 cases: anything else stops it.
    if (graphics < 7 || graphics > 12) warnings.push(`The graphics setting is ${graphics}; Dune II takes only 7 to 12, and stops at any other ("Unrecognized graphic mode!").`);
    const driver = (n: number, what: string) => {
        if (n >= MUSIC_DRIVERS.length) {
            warnings.push(`The ${what} driver is ${n}, past the ${MUSIC_DRIVERS.length} in Dune II's list: the game would read whatever follows it.`);
            return `${n}: not in the list`;
        }
        const [file, ext, name] = MUSIC_DRIVERS[n];
        return n ? `${n}: ${name} (${file}, playing .${ext})` : '0: None';
    };
    let voiceName: string;
    if (voice >= VOICE_DRIVERS.length) {
        warnings.push(`The voice driver is ${voice}, past the ${VOICE_DRIVERS.length} in Dune II's list: the game would read whatever follows it.`);
        voiceName = `${voice}: not in the list`;
    } else voiceName = voice ? `${voice}: ${VOICE_DRIVERS[voice][1]} (${VOICE_DRIVERS[voice][0]})` : '0: None';

    const stored = (i: number, name: string, value: string | number, note?: string) => field(name, i, 1, value, `Stored as ${data[i]} (the value plus ${7 - i}, XOR 0xA5).${note ? ` ${note}` : ''}`);
    const fields: Field[] = [
        stored(0, 'Graphics', graphics, 'The game takes 7 to 12; what each means isn’t known (OpenDUNE doesn’t read it).'),
        stored(1, 'Music driver', driver(music, 'music')),
        stored(2, 'Sound effects driver', driver(sound, 'sound effects')),
        stored(3, 'Voice driver', voiceName, 'For the digitized speech.'),
        stored(4, 'Use the mouse', onOff(mouse)),
        stored(5, 'Use extended memory (XMS)', onOff(xms), 'Without it, the game turns the voices off.'),
        stored(6, 'Unknown', unknown6, 'Nothing is known to read it.'),
        stored(7, 'Unknown', unknown7, 'Nothing is known to read it.'),
        field('Language', 8, 1, language < LANGUAGES.length ? `${language}: ${LANGUAGES[language]}` : language, 'Stored as it is. Which .ENG, .FRE or .GER files the game reads.'),
        field('Checksum', 9, 1, data[9], checksum === data[9] ? 'The sum of the 8 settings, XOR 0xA5: it matches.' : `The sum of the 8 settings, XOR 0xA5, is ${checksum}.`),
    ];
    return {
        title: 'Settings (Dune II DUNE.CFG)',
        summary: [
            ['Music', driver(music, 'music').replace(/^\d+: /, '')],
            ['Sound effects', driver(sound, 'sound effects').replace(/^\d+: /, '')],
            ['Voices', voiceName.replace(/^\d+: /, '')],
            ['Language', LANGUAGES[language] ?? `${language} (none of Dune II’s)`],
            ['Checksum', checksum === data[9] ? 'Good' : 'Wrong: the game won’t start'],
        ],
        fields,
        // The music and effects driver lists in the game are the same; warnings above would repeat for both.
        warnings: [...new Set(warnings)],
        end: 10,
    };
}

function options(data: Uint8Array): Parsed {
    const value = (i: number) => data[i * 2] | (data[i * 2 + 1] << 8);
    const [music, sounds, speed, hints, scroll] = [0, 1, 2, 3, 4].map(value);
    // Only values the game writes get here (the sniffer takes nothing else): each on or off, and the speed 0 to 4.
    const fields = [
        field('Music', 0, 2, onOff(music)),
        field('Sounds', 2, 2, onOff(sounds)),
        field('Game speed', 4, 2, `${speed}: ${SPEEDS[speed]}`, '0 (slowest) to 4 (fastest).'),
        field('Hints', 6, 2, onOff(hints)),
        field('Auto-scroll', 8, 2, onOff(scroll), 'Scrolling the map when the mouse reaches its edge.'),
    ];
    return {
        title: 'Game options (Dune II OPTIONS.CFG)',
        summary: [
            ['Music', onOff(music)],
            ['Sounds', onOff(sounds)],
            ['Game speed', SPEEDS[speed]],
            ['Hints', onOff(hints)],
            ['Auto-scroll', onOff(scroll)],
        ],
        fields,
        warnings: [],
        end: 10,
    };
}

const parser: FormatParser = {
    parse(data) {
        if (data.length !== 10) throw new Error(`Dune II's settings files are 10 bytes; this is ${data.length.toLocaleString('en-US')}.`);
        if (sniffDuneCfg(data)) return duneCfg(data);
        if (sniffDuneOptions(data)) return options(data);
        throw new Error("This isn't one of Dune II's settings files: its values fit neither DUNE.CFG's nor OPTIONS.CFG's.");
    },
};

export default parser;
