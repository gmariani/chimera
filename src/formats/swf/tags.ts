import type { SwfReader } from './reader';

/** Every tag in the SWF 19 spec, Macromedia's Generator and authoring tags, and the codes obfuscators add. */
export const TAG_NAMES: Record<number, string> = {
    0: 'End',
    1: 'ShowFrame',
    2: 'DefineShape',
    3: 'FreeCharacter',
    4: 'PlaceObject',
    5: 'RemoveObject',
    6: 'DefineBits',
    7: 'DefineButton',
    8: 'JPEGTables',
    9: 'SetBackgroundColor',
    10: 'DefineFont',
    11: 'DefineText',
    12: 'DoAction',
    13: 'DefineFontInfo',
    14: 'DefineSound',
    15: 'StartSound',
    16: 'StopSound',
    17: 'DefineButtonSound',
    18: 'SoundStreamHead',
    19: 'SoundStreamBlock',
    20: 'DefineBitsLossless',
    21: 'DefineBitsJPEG2',
    22: 'DefineShape2',
    23: 'DefineButtonCxform',
    24: 'Protect',
    25: 'PathsArePostscript',
    26: 'PlaceObject2',
    28: 'RemoveObject2',
    29: 'SyncFrame',
    31: 'FreeAll',
    32: 'DefineShape3',
    33: 'DefineText2',
    34: 'DefineButton2',
    35: 'DefineBitsJPEG3',
    36: 'DefineBitsLossless2',
    37: 'DefineEditText',
    38: 'DefineVideo',
    39: 'DefineSprite',
    40: 'NameCharacter',
    41: 'ProductInfo',
    42: 'DefineTextFormat',
    43: 'FrameLabel',
    44: 'DefineBehavior',
    45: 'SoundStreamHead2',
    46: 'DefineMorphShape',
    47: 'GenerateFrame',
    48: 'DefineFont2',
    49: 'GeneratorCommand',
    50: 'DefineCommandObject',
    51: 'CharacterSet',
    52: 'ExternalFont',
    53: 'DefineFunction',
    54: 'PlaceFunction',
    55: 'GeneratorTagObject',
    56: 'ExportAssets',
    57: 'ImportAssets',
    58: 'EnableDebugger',
    59: 'DoInitAction',
    60: 'DefineVideoStream',
    61: 'VideoFrame',
    62: 'DefineFontInfo2',
    63: 'DebugID',
    64: 'EnableDebugger2',
    65: 'ScriptLimits',
    66: 'SetTabIndex',
    69: 'FileAttributes',
    70: 'PlaceObject3',
    71: 'ImportAssets2',
    72: 'DoABC (early)',
    73: 'DefineFontAlignZones',
    74: 'CSMTextSettings',
    75: 'DefineFont3',
    76: 'SymbolClass',
    77: 'Metadata',
    78: 'DefineScalingGrid',
    82: 'DoABC',
    83: 'DefineShape4',
    84: 'DefineMorphShape2',
    86: 'DefineSceneAndFrameLabelData',
    87: 'DefineBinaryData',
    88: 'DefineFontName',
    89: 'StartSound2',
    90: 'DefineBitsJPEG4',
    91: 'DefineFont4',
    93: 'EnableTelemetry',
    253: 'Obfuscator (Amayeta SWF Encrypt)',
    255: 'Obfuscator (Amayeta SWF Encrypt 6)',
    264: 'Obfuscator (ObfuEncryption)',
    1002: 'Obfuscator (SWF Protector 3)',
    1022: 'Obfuscator (Amayeta SWF Compress)',
};

export const SOUND_FORMATS: Record<number, string> = { 0: 'Uncompressed, native byte order', 1: 'ADPCM', 2: 'MP3', 3: 'Uncompressed, little-endian', 4: 'Nellymoser 16 kHz', 5: 'Nellymoser 8 kHz', 6: 'Nellymoser', 11: 'Speex' };
export const SOUND_RATES = [5512, 11025, 22050, 44100];
const VIDEO_CODECS: Record<number, string> = { 1: 'JPEG', 2: 'Sorenson H.263', 3: 'Screen video', 4: 'On2 VP6', 5: 'On2 VP6 with alpha', 6: 'Screen video 2', 7: 'AVC (H.264)' };
const BITMAP_FORMATS: Record<number, string> = { 3: '8-bit, color-mapped', 4: '15-bit RGB', 5: '24-bit RGB' };
const LANGUAGES: Record<number, string> = { 0: 'None', 1: 'Latin', 2: 'Japanese', 3: 'Korean', 4: 'Simplified Chinese', 5: 'Traditional Chinese' };

/** A sound's format byte: format (4 bits), rate (2), 16-bit (1), stereo (1). */
export const soundFormat = (b: number) => ({ format: b >> 4, rate: SOUND_RATES[(b >> 2) & 3], bits: b & 2 ? 16 : 8, channels: b & 1 ? 2 : 1 });
const describeSound = (b: number) => {
    const s = soundFormat(b);
    return `${SOUND_FORMATS[s.format] ?? `format ${s.format}`}, ${s.rate} Hz, ${s.bits}-bit, ${s.channels === 2 ? 'stereo' : 'mono'}`;
};

const flags = (v: number, names: [number, string][]) => names.filter(([bit]) => v & bit).map(([, n]) => n).join(', ') || 'None';

/**
 * Reads a tag's body into fields. Returns a value to show beside the tag (an
 * ID, a name). The tags this doesn't break down are left as their data.
 */
export function readTag(code: number, r: SwfReader, nested: (r: SwfReader) => string | void): string | undefined {
    switch (code) {
        case 0:
        case 1:
            return;
        case 2:
        case 22:
        case 32:
        case 83: {
            const id = r.u16('Character ID');
            r.rect('Bounds');
            if (code === 83) {
                r.rect('Edge bounds');
                r.u8('Flags', 'Uses fill winding rule (bit 2), non-scaling strokes (1), scaling strokes (0).', (v) => flags(v, [[4, 'Fill winding rule'], [2, 'Non-scaling strokes'], [1, 'Scaling strokes']]));
            }
            r.bytes('Shapes', undefined, 'Fill and line styles, then shape records (edges and style changes), bit-packed.');
            return `#${id}`;
        }
        case 4: {
            const id = r.u16('Character ID');
            r.u16('Depth');
            r.matrix('Matrix');
            if (r.left) r.cxform('Color transform', false);
            return `#${id}`;
        }
        case 5:
            r.u16('Character ID');
            return `Depth ${r.u16('Depth')}`;
        case 28:
            return `Depth ${r.u16('Depth')}`;
        case 6:
        case 21: {
            const id = r.u16('Character ID');
            r.bytes('Image data', undefined, code === 6 ? 'JPEG without its tables, which are in the JPEGTables tag.' : 'A JPEG (with its tables), or from SWF 8 a PNG or GIF.');
            return `#${id}`;
        }
        case 35:
        case 90: {
            const id = r.u16('Character ID');
            const size = r.u32('Image data size');
            if (code === 90) r.fixed8('Deblocking', 'Strength of the deblocking filter, 0 to 1 (8.8 fixed point).');
            r.bytes('Image data', size, 'A JPEG, PNG or GIF.');
            if (r.left) r.bytes('Alpha data', undefined, 'zlib-compressed, a byte a pixel (JPEG only).');
            return `#${id}`;
        }
        case 8:
            r.bytes('JPEG tables', undefined, 'The tables every DefineBits JPEG shares.');
            return;
        case 9:
            return r.rgb('Color');
        case 10: {
            const id = r.u16('Font ID');
            r.bytes('Glyphs', undefined, 'An offset table, then each glyph\'s shape.');
            return `#${id}`;
        }
        case 48:
        case 75: {
            const id = r.u16('Font ID');
            r.u8('Flags', undefined, (v) => flags(v, [[0x80, 'Has layout'], [0x40, 'Shift-JIS'], [0x20, 'Small text'], [0x10, 'ANSI'], [0x08, 'Wide offsets'], [0x04, 'Wide codes'], [0x02, 'Italic'], [0x01, 'Bold']]));
            r.u8('Language', undefined, (v) => LANGUAGES[v] ?? String(v));
            const name = r.shortString('Name');
            r.u16('Glyph count');
            r.bytes('Glyphs', undefined, 'Offsets, glyph shapes, character codes, then the layout (if any).');
            return `#${id} ${name}`;
        }
        case 91: {
            const id = r.u16('Font ID');
            r.u8('Flags', undefined, (v) => flags(v, [[4, 'Has font data'], [2, 'Italic'], [1, 'Bold']]));
            const name = r.string('Name');
            if (r.left) r.bytes('Font data', undefined, 'An OpenType CFF font.');
            return `#${id} ${name}`;
        }
        case 11:
        case 33: {
            const id = r.u16('Character ID');
            r.rect('Bounds');
            r.matrix('Matrix');
            r.u8('Glyph bits', 'Bits in each glyph index.');
            r.u8('Advance bits', 'Bits in each glyph advance.');
            r.bytes('Text records', undefined, 'Style changes (font, color, position) and glyph runs.');
            return `#${id}`;
        }
        case 12:
            r.bytes('Actions', undefined, 'ActionScript 1 and 2 bytecode (AVM1), ending with a 0.');
            return;
        case 59:
            r.u16('Sprite ID');
            r.bytes('Actions', undefined, 'ActionScript 1 and 2 bytecode (AVM1), run once before the sprite\'s first frame.');
            return;
        case 13:
        case 62: {
            const id = r.u16('Font ID');
            const name = r.shortString('Name');
            r.u8('Flags', undefined, (v) => flags(v, [[0x20, 'Small text'], [0x10, 'Shift-JIS'], [0x08, 'ANSI'], [0x04, 'Italic'], [0x02, 'Bold'], [0x01, 'Wide codes']]));
            if (code === 62) r.u8('Language', undefined, (v) => LANGUAGES[v] ?? String(v));
            r.bytes('Character codes', undefined, 'One for each of the font\'s glyphs.');
            return `#${id} ${name}`;
        }
        case 14: {
            const id = r.u16('Sound ID');
            const format = r.u8('Format', 'Format (4 bits), rate (2), 16-bit (1), stereo (1).', describeSound);
            r.u32('Sample count');
            r.bytes('Sound data', undefined, soundFormat(format).format === 2 ? 'A 16-bit seek, then MP3 frames.' : undefined);
            return `#${id}, ${SOUND_FORMATS[soundFormat(format).format] ?? 'unknown'}`;
        }
        case 15: {
            const id = r.u16('Sound ID');
            r.bytes('Sound info', undefined, 'Whether to stop, loop or fade it.');
            return `#${id}`;
        }
        case 89:
            return r.string('Class name');
        case 18:
        case 45: {
            r.u8('Playback', 'Rate (bits 2–3), 16-bit (1), stereo (0) the player mixes at.', describeSound);
            const format = r.u8('Stream format', undefined, describeSound);
            r.u16('Samples per block', 'Average, per frame.');
            if (soundFormat(format).format === 2 && r.left >= 2) r.s16('Latency seek', 'MP3 samples to skip at the start.');
            return SOUND_FORMATS[soundFormat(format).format];
        }
        case 19:
            r.bytes('Sound data', undefined, 'This frame\'s part of the streaming sound (for MP3, a sample count and seek first).');
            return;
        case 20:
        case 36: {
            const id = r.u16('Character ID');
            const format = r.u8('Format', undefined, (v) => BITMAP_FORMATS[v] ?? String(v));
            const w = r.u16('Width');
            const h = r.u16('Height');
            if (format === 3) r.u8('Color table size', 'One less than the number of colors.');
            r.bytes('Bitmap data', undefined, `zlib-compressed ${code === 36 ? 'ARGB (premultiplied)' : 'RGB'}${format === 3 ? ': the color table, then indexes' : ''}, each row padded to 4 bytes.`);
            return `#${id}, ${w} × ${h}`;
        }
        case 24:
        case 58:
        case 64:
            if (code === 64) r.u16('Reserved');
            if (r.left) r.string('Password', 'MD5-hashed.');
            return;
        case 26:
        case 70: {
            const f = r.u8('Flags', undefined, (v) => flags(v, [[0x80, 'Clip actions'], [0x40, 'Clip depth'], [0x20, 'Name'], [0x10, 'Ratio'], [0x08, 'Color transform'], [0x04, 'Matrix'], [0x02, 'Character'], [0x01, 'Move']]));
            const f2 = code === 70 ? r.u8('More flags', undefined, (v) => flags(v, [[0x40, 'Opaque background'], [0x20, 'Visible'], [0x10, 'Image'], [0x08, 'Class name'], [0x04, 'Cache as bitmap'], [0x02, 'Blend mode'], [0x01, 'Filters']])) : 0;
            const depth = r.u16('Depth');
            if (f2 & 0x08 || (f2 & 0x10 && f & 0x02)) r.string('Class name');
            let id: number | undefined;
            if (f & 0x02) id = r.u16('Character ID');
            if (f & 0x04) r.matrix('Matrix');
            if (f & 0x08) r.cxform('Color transform', true);
            if (f & 0x10) r.u16('Ratio', 'How far along a morph shape is (0 to 65535).');
            const name = f & 0x20 ? r.string('Name') : undefined;
            if (f & 0x40) r.u16('Clip depth');
            if (r.left) r.bytes(code === 70 ? 'Filters, blend mode, cache, visibility, clip actions' : 'Clip actions');
            return [id !== undefined && `#${id}`, `depth ${depth}`, name && `"${name}"`].filter(Boolean).join(', ');
        }
        case 7:
        case 34: {
            const id = r.u16('Button ID');
            if (code === 34) {
                r.u8('Flags', undefined, (v) => (v & 1 ? 'Track as menu' : 'Push button'));
                r.u16('Action offset', 'To the first condition action, from this field (0: none).');
            }
            r.bytes('Records and actions', undefined, 'Which characters show in each state, then the actions.');
            return `#${id}`;
        }
        case 17:
        case 23:
            r.u16('Button ID');
            r.bytes(code === 17 ? 'Sounds' : 'Color transform');
            return;
        case 37: {
            const id = r.u16('Character ID');
            r.rect('Bounds');
            const f = r.u16('Flags', undefined, (v) =>
                flags(v, [[0x80, 'Has text'], [0x40, 'Word wrap'], [0x20, 'Multiline'], [0x10, 'Password'], [0x08, 'Read only'], [0x04, 'Has text color'], [0x02, 'Has max length'], [0x01, 'Has font'], [0x8000, 'Has font class'], [0x4000, 'Auto size'], [0x2000, 'Has layout'], [0x1000, 'No select'], [0x0800, 'Border'], [0x0400, 'Was static'], [0x0200, 'HTML'], [0x0100, 'Use outlines']]),
            );
            if (f & 0x01) r.u16('Font ID');
            if (f & 0x8000) r.string('Font class');
            if (f & 0x01 || f & 0x8000) r.u16('Font height', 'In twips.');
            if (f & 0x04) r.rgba('Text color');
            if (f & 0x02) r.u16('Max length');
            if (f & 0x2000) {
                r.u8('Align', undefined, (v) => ['Left', 'Right', 'Center', 'Justify'][v] ?? String(v));
                r.u16('Left margin');
                r.u16('Right margin');
                r.u16('Indent');
                r.s16('Leading');
            }
            const variable = r.string('Variable name');
            const text = f & 0x80 ? r.string('Initial text') : '';
            return `#${id}${variable ? ` ${variable}` : ''}${text ? `: ${text.slice(0, 40)}` : ''}`;
        }
        case 39: {
            const id = r.u16('Sprite ID');
            r.u16('Frame count');
            nested(r);
            return `#${id}`;
        }
        case 41: {
            r.u32('Product', undefined, (v) => ({ 0: 'Unknown', 1: 'Macromedia Flex for J2EE', 2: 'Macromedia Flex for .NET', 3: 'Adobe Flex' })[v] ?? String(v));
            r.u32('Edition', undefined, (v) => ['Developer', 'Full commercial', 'Non-commercial', 'Trial', 'Educational', 'Not for resale', 'Free'][v] ?? String(v));
            const major = r.u8('Major version');
            const minor = r.u8('Minor version');
            const low = r.u32('Build (low)');
            const high = r.u32('Build (high)');
            if (r.left >= 8) r.bytes('Compiled', 8, 'Milliseconds since 1970.', new Date(Number(new DataView(r.data.buffer, r.data.byteOffset).getBigUint64(r.at, true))).toISOString());
            return `${major}.${minor} build ${high * 2 ** 32 + low}`;
        }
        case 43: {
            const name = r.string('Name');
            if (r.left) r.u8('Named anchor');
            return name;
        }
        case 46:
        case 84: {
            const id = r.u16('Character ID');
            r.rect('Start bounds');
            r.rect('End bounds');
            if (code === 84) {
                r.rect('Start edge bounds');
                r.rect('End edge bounds');
                r.u8('Flags', undefined, (v) => flags(v, [[2, 'Non-scaling strokes'], [1, 'Scaling strokes']]));
            }
            r.u32('End edges offset');
            r.bytes('Shapes', undefined, 'Morph fill and line styles, then the start and end shape records.');
            return `#${id}`;
        }
        case 56:
        case 57:
        case 71: {
            const url = code !== 56 ? r.string('URL') : '';
            if (code === 71) (r.u8('Reserved'), r.u8('Reserved'));
            const count = r.u16('Count');
            for (let i = 0; i < count && r.left; i++) {
                const from = r.fields.length;
                const start = r.at;
                const id = r.u16('Character ID');
                const name = r.string('Name');
                r.group(name, from, start, `#${id}`);
            }
            return `${count} asset${count === 1 ? '' : 's'}${url ? ` from ${url}` : ''}`;
        }
        case 60: {
            const id = r.u16('Character ID');
            r.u16('Frame count');
            const w = r.u16('Width');
            const h = r.u16('Height');
            r.u8('Flags', 'Deblocking (bits 1–3), smoothing (bit 0).', (v) => `Deblocking ${['from the video', 'off', 'level 1', 'level 2', 'level 3', 'level 4'][(v >> 1) & 7] ?? (v >> 1) & 7}, smoothing ${v & 1 ? 'on' : 'off'}`);
            const codec = r.u8('Codec', undefined, (v) => VIDEO_CODECS[v] ?? String(v));
            return `#${id}, ${w} × ${h}, ${VIDEO_CODECS[codec] ?? 'unknown codec'}`;
        }
        case 61: {
            const id = r.u16('Stream ID');
            const frame = r.u16('Frame number');
            r.bytes('Video data');
            return `#${id} frame ${frame}`;
        }
        case 63:
            r.bytes('UUID', 16, 'Matches the SWD debug file made with this SWF.', Array.from(r.data.subarray(r.at, r.at + 16), (b) => b.toString(16).padStart(2, '0')).join(''));
            return;
        case 65:
            r.u16('Max recursion depth');
            r.u16('Script timeout', 'Seconds.');
            return;
        case 66:
            r.u16('Depth');
            return `Tab index ${r.u16('Tab index')}`;
        case 69: {
            const f = r.u32('Flags', undefined, (v) =>
                flags(v, [[0x40, 'Use direct blit'], [0x20, 'Use GPU'], [0x10, 'Has metadata'], [0x08, 'ActionScript 3'], [0x04, 'No cross-domain caching'], [0x02, 'Relative URLs'], [0x01, 'Use network']]),
            );
            return f & 0x08 ? 'ActionScript 3' : 'ActionScript 1/2';
        }
        case 72:
        case 82: {
            const name = code === 82 ? (r.u32('Flags', undefined, (v) => (v & 1 ? 'Lazy initialize' : 'None')), r.string('Name')) : '';
            const minor = r.u16('ABC minor version');
            const major = r.u16('ABC major version');
            r.bytes('ABC data', undefined, 'The constant pool, methods, classes and scripts (AVM2 bytecode).');
            return `${name ? `${name}, ` : ''}ABC ${major}.${minor}`;
        }
        case 73: {
            const id = r.u16('Font ID');
            r.u8('CSM table hint', undefined, (v) => ['Thin', 'Medium', 'Thick'][v >> 6] ?? String(v));
            r.bytes('Zones', undefined, 'Each glyph\'s alignment zones.');
            return `#${id}`;
        }
        case 74: {
            const id = r.u16('Text ID');
            r.u8('Flags', 'Renderer (bits 6–7), grid fit (3–5).', (v) => `${['Normal', 'Advanced'][v >> 6] ?? 'Renderer ' + (v >> 6)}, grid fit ${['none', 'pixel', 'subpixel'][(v >> 3) & 7] ?? (v >> 3) & 7}`);
            r.f32('Thickness');
            r.f32('Sharpness');
            if (r.left) r.u8('Reserved');
            return `#${id}`;
        }
        case 76: {
            const count = r.u16('Count');
            const names: string[] = [];
            for (let i = 0; i < count && r.left; i++) {
                const from = r.fields.length;
                const start = r.at;
                const id = r.u16('Character ID');
                const name = r.string('Class name');
                names.push(name);
                r.group(name, from, start, id === 0 ? 'The document class' : `#${id}`);
            }
            return names.length === 1 ? names[0] : `${count} classes`;
        }
        case 77:
            r.string('XML', 'XMP (RDF) metadata.');
            return;
        case 78: {
            const id = r.u16('Character ID');
            r.rect('Center region');
            return `#${id}`;
        }
        case 86: {
            const scenes = r.encodedU32('Scene count');
            for (let i = 0; i < scenes && r.left; i++) {
                const from = r.fields.length;
                const start = r.at;
                const frame = r.encodedU32('Frame offset');
                const name = r.string('Name');
                r.group(`Scene ${i + 1}`, from, start, `${name}, from frame ${frame}`);
            }
            const labels = r.encodedU32('Frame label count');
            for (let i = 0; i < labels && r.left; i++) {
                const from = r.fields.length;
                const start = r.at;
                const frame = r.encodedU32('Frame number');
                const name = r.string('Label');
                r.group(`Label ${i + 1}`, from, start, `${name}, frame ${frame}`);
            }
            return `${scenes} scene${scenes === 1 ? '' : 's'}, ${labels} label${labels === 1 ? '' : 's'}`;
        }
        case 87: {
            const id = r.u16('Character ID');
            r.u32('Reserved');
            r.bytes('Data');
            return `#${id}`;
        }
        case 88: {
            const id = r.u16('Font ID');
            const name = r.string('Name');
            r.string('Copyright');
            return `#${id} ${name}`;
        }
    }
    if (r.left) r.bytes('Data');
    return;
}
