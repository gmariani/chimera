import { bytesLabel, field, hex } from '../../core/bytes';
import type { Field } from '../../core/types';

/**
 * EXIF: a small TIFF file inside an APP1 segment. A byte order ("II" little-,
 * "MM" big-endian), 42, and the offset of the first IFD: a count, then 12-byte
 * entries (tag, type, count, and the value, or its offset when it's over 4
 * bytes), then the offset of the next IFD. IFD0 describes the picture and
 * points to the Exif, GPS and Interoperability IFDs; IFD1 is the thumbnail.
 * Offsets count from the byte order mark. After Exif 2.31 (JEITA CP-3451).
 */

const TIFF_TAGS: Record<number, string> = {
    0x00fe: 'NewSubfileType',
    0x0100: 'ImageWidth',
    0x0101: 'ImageHeight',
    0x0102: 'BitsPerSample',
    0x0103: 'Compression',
    0x0106: 'PhotometricInterpretation',
    0x010e: 'ImageDescription',
    0x010f: 'Make',
    0x0110: 'Model',
    0x0111: 'StripOffsets',
    0x0112: 'Orientation',
    0x0115: 'SamplesPerPixel',
    0x0116: 'RowsPerStrip',
    0x0117: 'StripByteCounts',
    0x011a: 'XResolution',
    0x011b: 'YResolution',
    0x011c: 'PlanarConfiguration',
    0x0128: 'ResolutionUnit',
    0x012d: 'TransferFunction',
    0x0131: 'Software',
    0x0132: 'DateTime',
    0x013b: 'Artist',
    0x013c: 'HostComputer',
    0x013e: 'WhitePoint',
    0x013f: 'PrimaryChromaticities',
    0x0201: 'JPEGInterchangeFormat',
    0x0202: 'JPEGInterchangeFormatLength',
    0x0211: 'YCbCrCoefficients',
    0x0212: 'YCbCrSubSampling',
    0x0213: 'YCbCrPositioning',
    0x0214: 'ReferenceBlackWhite',
    0x02bc: 'ApplicationNotes',
    0x4746: 'Rating',
    0x4749: 'RatingPercent',
    0x8298: 'Copyright',
    0x83bb: 'IPTC-NAA',
    0x8769: 'ExifIFDPointer',
    0x8825: 'GPSInfoIFDPointer',
    0x9c9b: 'XPTitle',
    0x9c9c: 'XPComment',
    0x9c9d: 'XPAuthor',
    0x9c9e: 'XPKeywords',
    0x9c9f: 'XPSubject',
    0xc4a5: 'PrintIM',
    0xea1c: 'Padding',
};

const EXIF_TAGS: Record<number, string> = {
    0x829a: 'ExposureTime',
    0x829d: 'FNumber',
    0x8822: 'ExposureProgram',
    0x8824: 'SpectralSensitivity',
    0x8827: 'ISOSpeedRatings',
    0x8828: 'OECF',
    0x8830: 'SensitivityType',
    0x8832: 'RecommendedExposureIndex',
    0x9000: 'ExifVersion',
    0x9003: 'DateTimeOriginal',
    0x9004: 'DateTimeDigitized',
    0x9010: 'OffsetTime',
    0x9011: 'OffsetTimeOriginal',
    0x9012: 'OffsetTimeDigitized',
    0x9101: 'ComponentsConfiguration',
    0x9102: 'CompressedBitsPerPixel',
    0x9201: 'ShutterSpeedValue',
    0x9202: 'ApertureValue',
    0x9203: 'BrightnessValue',
    0x9204: 'ExposureBiasValue',
    0x9205: 'MaxApertureValue',
    0x9206: 'SubjectDistance',
    0x9207: 'MeteringMode',
    0x9208: 'LightSource',
    0x9209: 'Flash',
    0x920a: 'FocalLength',
    0x9214: 'SubjectArea',
    0x927c: 'MakerNote',
    0x9286: 'UserComment',
    0x9290: 'SubSecTime',
    0x9291: 'SubSecTimeOriginal',
    0x9292: 'SubSecTimeDigitized',
    0xa000: 'FlashpixVersion',
    0xa001: 'ColorSpace',
    0xa002: 'PixelXDimension',
    0xa003: 'PixelYDimension',
    0xa004: 'RelatedSoundFile',
    0xa005: 'InteroperabilityIFDPointer',
    0xa20b: 'FlashEnergy',
    0xa20c: 'SpatialFrequencyResponse',
    0xa20e: 'FocalPlaneXResolution',
    0xa20f: 'FocalPlaneYResolution',
    0xa210: 'FocalPlaneResolutionUnit',
    0xa214: 'SubjectLocation',
    0xa215: 'ExposureIndex',
    0xa217: 'SensingMethod',
    0xa300: 'FileSource',
    0xa301: 'SceneType',
    0xa302: 'CFAPattern',
    0xa401: 'CustomRendered',
    0xa402: 'ExposureMode',
    0xa403: 'WhiteBalance',
    0xa404: 'DigitalZoomRatio',
    0xa405: 'FocalLengthIn35mmFilm',
    0xa406: 'SceneCaptureType',
    0xa407: 'GainControl',
    0xa408: 'Contrast',
    0xa409: 'Saturation',
    0xa40a: 'Sharpness',
    0xa40b: 'DeviceSettingDescription',
    0xa40c: 'SubjectDistanceRange',
    0xa420: 'ImageUniqueID',
    0xa430: 'CameraOwnerName',
    0xa431: 'BodySerialNumber',
    0xa432: 'LensSpecification',
    0xa433: 'LensMake',
    0xa434: 'LensModel',
    0xa435: 'LensSerialNumber',
    0xa500: 'Gamma',
    0xea1c: 'Padding',
};

const GPS_TAGS: Record<number, string> = {
    0x00: 'GPSVersionID',
    0x01: 'GPSLatitudeRef',
    0x02: 'GPSLatitude',
    0x03: 'GPSLongitudeRef',
    0x04: 'GPSLongitude',
    0x05: 'GPSAltitudeRef',
    0x06: 'GPSAltitude',
    0x07: 'GPSTimeStamp',
    0x08: 'GPSSatellites',
    0x09: 'GPSStatus',
    0x0a: 'GPSMeasureMode',
    0x0b: 'GPSDOP',
    0x0c: 'GPSSpeedRef',
    0x0d: 'GPSSpeed',
    0x0e: 'GPSTrackRef',
    0x0f: 'GPSTrack',
    0x10: 'GPSImgDirectionRef',
    0x11: 'GPSImgDirection',
    0x12: 'GPSMapDatum',
    0x13: 'GPSDestLatitudeRef',
    0x14: 'GPSDestLatitude',
    0x15: 'GPSDestLongitudeRef',
    0x16: 'GPSDestLongitude',
    0x17: 'GPSDestBearingRef',
    0x18: 'GPSDestBearing',
    0x19: 'GPSDestDistanceRef',
    0x1a: 'GPSDestDistance',
    0x1b: 'GPSProcessingMethod',
    0x1c: 'GPSAreaInformation',
    0x1d: 'GPSDateStamp',
    0x1e: 'GPSDifferential',
    0x1f: 'GPSHPositioningError',
};

const INTEROP_TAGS: Record<number, string> = { 0x0001: 'InteroperabilityIndex', 0x0002: 'InteroperabilityVersion', 0x1000: 'RelatedImageFileFormat', 0x1001: 'RelatedImageWidth', 0x1002: 'RelatedImageLength' };

const RESOLUTION_UNIT = { 1: 'None', 2: 'Inches', 3: 'Centimeters' };

/** What a tag's number stands for. */
const MEANINGS: Record<string, Record<number, string>> = {
    Compression: { 1: 'Uncompressed', 6: 'JPEG (old-style)', 7: 'JPEG' },
    PhotometricInterpretation: { 0: 'WhiteIsZero', 1: 'BlackIsZero', 2: 'RGB', 3: 'Palette', 5: 'CMYK', 6: 'YCbCr' },
    Orientation: { 1: 'Normal', 2: 'Mirrored', 3: 'Rotated 180°', 4: 'Mirrored vertically', 5: 'Mirrored and rotated 270° clockwise', 6: 'Rotated 90° clockwise', 7: 'Mirrored and rotated 90° clockwise', 8: 'Rotated 270° clockwise' },
    ResolutionUnit: RESOLUTION_UNIT,
    FocalPlaneResolutionUnit: RESOLUTION_UNIT,
    YCbCrPositioning: { 1: 'Centered', 2: 'Co-sited' },
    PlanarConfiguration: { 1: 'Chunky', 2: 'Planar' },
    ColorSpace: { 1: 'sRGB', 0xffff: 'Uncalibrated' },
    ExposureProgram: { 0: 'Not defined', 1: 'Manual', 2: 'Normal program', 3: 'Aperture priority', 4: 'Shutter priority', 5: 'Creative program', 6: 'Action program', 7: 'Portrait mode', 8: 'Landscape mode' },
    MeteringMode: { 0: 'Unknown', 1: 'Average', 2: 'Center-weighted average', 3: 'Spot', 4: 'Multi-spot', 5: 'Pattern', 6: 'Partial', 255: 'Other' },
    LightSource: { 0: 'Unknown', 1: 'Daylight', 2: 'Fluorescent', 3: 'Tungsten', 4: 'Flash', 9: 'Fine weather', 10: 'Cloudy', 11: 'Shade', 17: 'Standard light A', 18: 'Standard light B', 19: 'Standard light C', 20: 'D55', 21: 'D65', 22: 'D75', 23: 'D50', 24: 'ISO studio tungsten', 255: 'Other' },
    SensingMethod: { 1: 'Not defined', 2: 'One-chip color area', 3: 'Two-chip color area', 4: 'Three-chip color area', 5: 'Color sequential area', 7: 'Trilinear', 8: 'Color sequential linear' },
    CustomRendered: { 0: 'Normal', 1: 'Custom' },
    ExposureMode: { 0: 'Auto', 1: 'Manual', 2: 'Auto bracket' },
    WhiteBalance: { 0: 'Auto', 1: 'Manual' },
    SceneCaptureType: { 0: 'Standard', 1: 'Landscape', 2: 'Portrait', 3: 'Night' },
    GainControl: { 0: 'None', 1: 'Low gain up', 2: 'High gain up', 3: 'Low gain down', 4: 'High gain down' },
    Contrast: { 0: 'Normal', 1: 'Soft', 2: 'Hard' },
    Saturation: { 0: 'Normal', 1: 'Low', 2: 'High' },
    Sharpness: { 0: 'Normal', 1: 'Soft', 2: 'Hard' },
    SubjectDistanceRange: { 0: 'Unknown', 1: 'Macro', 2: 'Close', 3: 'Distant' },
    FileSource: { 3: 'Digital camera' },
    SceneType: { 1: 'Directly photographed' },
    GPSAltitudeRef: { 0: 'Above sea level', 1: 'Below sea level' },
};

/** Bytes per value of each TIFF type. */
const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];
const TYPE_NAME = ['', 'BYTE', 'ASCII', 'SHORT', 'LONG', 'RATIONAL', 'SBYTE', 'UNDEFINED', 'SSHORT', 'SLONG', 'SRATIONAL', 'FLOAT', 'DOUBLE'];

/** Undefined-type tags that hold four ASCII digits. */
const VERSIONS = new Set(['ExifVersion', 'FlashpixVersion', 'InteroperabilityVersion']);

/** At most this many values are listed; longer arrays are summed up. */
const MAX_VALUES = 16;

export interface Exif {
    fields: Field[];
    /** Every tag read, by name: its first value (a number, or the text). */
    tags: Map<string, number | string>;
    /** The GPS position in degrees, when it's there. */
    position?: [number, number];
    /** The thumbnail JPEG (IFD1), as absolute offsets. */
    thumbnail?: { offset: number; length: number };
    warnings: string[];
}

/** Reads the TIFF structure starting at `base` (the byte order mark) and ending by `end`. */
export function readExif(data: Uint8Array, base: number, end: number): Exif {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const little = data[base] === 0x49;
    const inside = (at: number, length: number) => at >= base && at + length <= end;
    const u16 = (at: number) => (inside(at, 2) ? view.getUint16(at, little) : 0);
    const u32 = (at: number) => (inside(at, 4) ? view.getUint32(at, little) : 0);
    const out: Exif = { fields: [], tags: new Map(), warnings: [] };
    const rationals = new Map<string, number[]>();
    const visited = new Set<number>();

    out.fields.push({
        name: 'TIFF header',
        offset: base,
        length: 8,
        children: [field('Byte order', base, 2, little ? 'II (little-endian)' : 'MM (big-endian)'), field('Magic', base + 2, 2, u16(base + 2), 'Always 42.'), field('IFD0 offset', base + 4, 4, u32(base + 4))],
    });

    /** One value of a tag, as a number. */
    const number = (type: number, at: number): number => {
        switch (type) {
            case 1: case 2: case 7: return data[at]; // prettier-ignore
            case 3: return u16(at);
            case 4: return u32(at);
            case 6: return (data[at] << 24) >> 24;
            case 8: return (u16(at) << 16) >> 16;
            case 9: return view.getInt32(at, little);
            case 5: { const d = u32(at + 4); return d ? u32(at) / d : 0; } // prettier-ignore
            case 10: { const d = view.getInt32(at + 4, little); return d ? view.getInt32(at, little) / d : 0; } // prettier-ignore
            case 11: return view.getFloat32(at, little);
            case 12: return view.getFloat64(at, little);
        }
        return 0;
    };
    const rational = (type: number, at: number): string => {
        const [n, d] = type === 5 ? [u32(at), u32(at + 4)] : [view.getInt32(at, little), view.getInt32(at + 4, little)];
        if (d === 0) return 'undefined';
        if (n % d === 0) return String(n / d);
        // Exposure times read best as a fraction of a second.
        if (n === 1 || (n > 0 && d % n === 0 && n < d)) return `1/${d / n}`;
        return String(+(n / d).toPrecision(6));
    };

    const readIfd = (name: string, at: number, names: Record<number, string>) => {
        if (!inside(at, 2) || visited.has(at)) return 0;
        visited.add(at);
        const count = u16(at);
        const children: Field[] = [field('Entry count', at, 2, count)];
        const pointers: [string, number, Record<number, string>][] = [];
        for (let i = 0; i < count; i++) {
            const entry = at + 2 + i * 12;
            if (!inside(entry, 12)) {
                out.warnings.push(`${name} runs past the end of the EXIF data.`);
                break;
            }
            const id = u16(entry);
            const type = u16(entry + 2);
            const n = u32(entry + 4);
            const size = (TYPE_SIZE[type] ?? 0) * n;
            const valueAt = size <= 4 ? entry + 8 : base + u32(entry + 8);
            const tag = names[id] ?? TIFF_TAGS[id] ?? `Tag 0x${hex(id, 4)}`;
            const what = `${TYPE_NAME[type] ?? `type ${type}`} × ${n}`;
            let value: string;
            if (!TYPE_SIZE[type] || !inside(valueAt, size)) {
                value = size && TYPE_SIZE[type] ? 'Out of range' : 'Unknown type';
            } else if (type === 2) {
                let text = '';
                for (let k = 0; k < n && data[valueAt + k]; k++) text += String.fromCharCode(data[valueAt + k]);
                value = text.trim();
                out.tags.set(tag, value);
            } else if (type === 7 && VERSIONS.has(tag)) {
                value = String.fromCharCode(...data.subarray(valueAt, valueAt + Math.min(n, 4)));
            } else if (type === 7 && tag === 'UserComment') {
                const charset = String.fromCharCode(...data.subarray(valueAt, valueAt + 8)).replace(/\0+$/, '');
                const text = charset === 'ASCII' ? String.fromCharCode(...data.subarray(valueAt + 8, valueAt + n)).replace(/\0+$/, '').trim() : '';
                value = text || (charset ? `${charset} text` : bytesLabel(n));
            } else if (type === 1 && tag.startsWith('XP')) {
                // Windows' tags: UTF-16LE text in bytes.
                value = new TextDecoder('utf-16le').decode(data.subarray(valueAt, valueAt + n)).replace(/\0+$/, '');
            } else if ((type === 7 || type === 1) && n > MAX_VALUES) {
                value = bytesLabel(n);
            } else if (type === 7) {
                value = Array.from(data.subarray(valueAt, valueAt + n), (b) => hex(b, 2)).join(' ');
            } else {
                const values: string[] = [];
                const numbers: number[] = [];
                for (let k = 0; k < Math.min(n, MAX_VALUES); k++) {
                    const at = valueAt + k * TYPE_SIZE[type];
                    numbers.push(number(type, at));
                    values.push(type === 5 || type === 10 ? rational(type, at) : String(+number(type, at).toPrecision(7)));
                }
                if (type === 5 || type === 10) rationals.set(tag, numbers);
                out.tags.set(tag, numbers[0]);
                const meaning = n === 1 ? (tag === 'Flash' ? flash(numbers[0]) : MEANINGS[tag]?.[numbers[0]]) : undefined;
                value = meaning ? `${values[0]} (${meaning})` : values.join(', ') + (n > MAX_VALUES ? `, … (${n} in all)` : '');
                if (tag === 'ExifIFDPointer') pointers.push(['Exif IFD', base + numbers[0], EXIF_TAGS]);
                if (tag === 'GPSInfoIFDPointer') pointers.push(['GPS IFD', base + numbers[0], GPS_TAGS]);
                if (tag === 'InteroperabilityIFDPointer') pointers.push(['Interoperability IFD', base + numbers[0], INTEROP_TAGS]);
            }
            const note = tag === 'MakerNote' ? 'In the camera maker\'s own format.' : undefined;
            // The entry's four parts, and the value where it's stored: in the entry when it fits in 4 bytes, else at its offset.
            const parts = [
                field('Tag', entry, 2, `0x${hex(id, 4)}`),
                field('Type', entry + 2, 2, `${type} (${TYPE_NAME[type] || 'unknown'})`),
                field('Count', entry + 4, 4, n, 'Values, not bytes.'),
                size <= 4 ? field('Value', entry + 8, 4, value, size < 4 ? 'Left-aligned; the rest is padding.' : undefined) : field('Value offset', entry + 8, 4, u32(entry + 8), 'From the TIFF header.'),
                ...(size > 4 ? [field('Value', valueAt, size, value)] : []),
            ];
            children.push({ name: tag, offset: entry, length: 12, value, note: [note, `${what}.`].filter(Boolean).join(' '), children: parts });
        }
        const next = at + 2 + count * 12;
        children.push(field('Next IFD offset', next, 4, u32(next)));
        out.fields.push({ name, offset: at, length: 2 + count * 12 + 4, children });
        for (const [label, offset, table] of pointers) readIfd(label, offset, table);
        return u32(next);
    };

    const ifd1 = readIfd('IFD0', base + u32(base + 4), TIFF_TAGS);
    // IFD1 describes the thumbnail, a JPEG of its own.
    if (ifd1) {
        const before = new Map(out.tags);
        out.tags.delete('JPEGInterchangeFormat');
        readIfd('IFD1 (thumbnail)', base + ifd1, TIFF_TAGS);
        const offset = out.tags.get('JPEGInterchangeFormat');
        const length = out.tags.get('JPEGInterchangeFormatLength');
        if (typeof offset === 'number' && typeof length === 'number' && length > 0 && inside(base + offset, length)) {
            out.thumbnail = { offset: base + offset, length };
            out.fields.push(field('Thumbnail', base + offset, length, bytesLabel(length), 'A JPEG of its own.'));
        }
        // The summary describes the picture, not its thumbnail.
        for (const [k, v] of before) out.tags.set(k, v);
    }

    const lat = rationals.get('GPSLatitude');
    const lon = rationals.get('GPSLongitude');
    if (lat?.length === 3 && lon?.length === 3) {
        const degrees = ([d, m, s]: number[], negative: boolean) => (negative ? -1 : 1) * (d + m / 60 + s / 3600);
        out.position = [degrees(lat, out.tags.get('GPSLatitudeRef') === 'S'), degrees(lon, out.tags.get('GPSLongitudeRef') === 'W')];
    }
    return out;
}

/** The Flash tag's bits: fired, the strobe's return, the mode, red-eye. */
function flash(v: number): string {
    if (v & 0x20) return 'No flash';
    const parts = [v & 1 ? 'Fired' : 'Didn\'t fire'];
    const mode = (v >> 3) & 3;
    if (mode) parts.push(['', 'compulsory', 'suppressed', 'auto'][mode]);
    if (v & 0x40) parts.push('red-eye reduction');
    return parts.join(', ');
}
