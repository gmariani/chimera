import { bytesLabel, field, hex } from '../../core/bytes';
import type { Field } from '../../core/types';

/**
 * TIFF's structure, which EXIF borrows. A byte order ("II" little-, "MM"
 * big-endian), 42, and the offset of the first IFD (image file directory): a
 * count, then 12-byte entries (tag, type, count, and the value, or its offset
 * when it's over 4 bytes), then the offset of the next IFD. In a TIFF file each
 * IFD in the chain is a page; in EXIF (inside a JPEG's APP1), IFD0 describes the
 * picture and IFD1 its thumbnail. Either can point to Exif, GPS and
 * Interoperability IFDs. Offsets count from the byte order mark. After TIFF 6.0
 * and Exif 2.31 (JEITA CP-3451).
 */

/** TIFF 6.0's tags (its Appendix A), and some others' that turn up in TIFF files: Adobe's, GeoTIFF's, DNG's. */
const TIFF_TAGS: Record<number, string> = {
    0x00fe: 'NewSubfileType',
    0x00ff: 'SubfileType',
    0x0100: 'ImageWidth',
    0x0101: 'ImageLength',
    0x0102: 'BitsPerSample',
    0x0103: 'Compression',
    0x0106: 'PhotometricInterpretation',
    0x0107: 'Threshholding',
    0x0108: 'CellWidth',
    0x0109: 'CellLength',
    0x010a: 'FillOrder',
    0x010d: 'DocumentName',
    0x010e: 'ImageDescription',
    0x010f: 'Make',
    0x0110: 'Model',
    0x0111: 'StripOffsets',
    0x0112: 'Orientation',
    0x0115: 'SamplesPerPixel',
    0x0116: 'RowsPerStrip',
    0x0117: 'StripByteCounts',
    0x0118: 'MinSampleValue',
    0x0119: 'MaxSampleValue',
    0x011a: 'XResolution',
    0x011b: 'YResolution',
    0x011c: 'PlanarConfiguration',
    0x011d: 'PageName',
    0x011e: 'XPosition',
    0x011f: 'YPosition',
    0x0120: 'FreeOffsets',
    0x0121: 'FreeByteCounts',
    0x0122: 'GrayResponseUnit',
    0x0123: 'GrayResponseCurve',
    0x0124: 'T4Options',
    0x0125: 'T6Options',
    0x0128: 'ResolutionUnit',
    0x0129: 'PageNumber',
    0x012d: 'TransferFunction',
    0x0131: 'Software',
    0x0132: 'DateTime',
    0x013b: 'Artist',
    0x013c: 'HostComputer',
    0x013d: 'Predictor',
    0x013e: 'WhitePoint',
    0x013f: 'PrimaryChromaticities',
    0x0140: 'ColorMap',
    0x0141: 'HalftoneHints',
    0x0142: 'TileWidth',
    0x0143: 'TileLength',
    0x0144: 'TileOffsets',
    0x0145: 'TileByteCounts',
    0x014a: 'SubIFDs',
    0x014c: 'InkSet',
    0x014d: 'InkNames',
    0x014e: 'NumberOfInks',
    0x0150: 'DotRange',
    0x0151: 'TargetPrinter',
    0x0152: 'ExtraSamples',
    0x0153: 'SampleFormat',
    0x0154: 'SMinSampleValue',
    0x0155: 'SMaxSampleValue',
    0x0156: 'TransferRange',
    0x015b: 'JPEGTables',
    0x0200: 'JPEGProc',
    0x0201: 'JPEGInterchangeFormat',
    0x0202: 'JPEGInterchangeFormatLength',
    0x0203: 'JPEGRestartInterval',
    0x0205: 'JPEGLosslessPredictors',
    0x0206: 'JPEGPointTransforms',
    0x0207: 'JPEGQTables',
    0x0208: 'JPEGDCTables',
    0x0209: 'JPEGACTables',
    0x0211: 'YCbCrCoefficients',
    0x0212: 'YCbCrSubSampling',
    0x0213: 'YCbCrPositioning',
    0x0214: 'ReferenceBlackWhite',
    0x02bc: 'XMP',
    0x4746: 'Rating',
    0x4749: 'RatingPercent',
    0x8298: 'Copyright',
    0x830e: 'ModelPixelScale',
    0x83bb: 'IPTC-NAA',
    0x8482: 'ModelTiepoint',
    0x85d8: 'ModelTransformation',
    0x8649: 'Photoshop',
    0x8769: 'ExifIFDPointer',
    0x8773: 'ICCProfile',
    0x87af: 'GeoKeyDirectory',
    0x87b0: 'GeoDoubleParams',
    0x87b1: 'GeoAsciiParams',
    0x8825: 'GPSInfoIFDPointer',
    0x9c9b: 'XPTitle',
    0x9c9c: 'XPComment',
    0x9c9d: 'XPAuthor',
    0x9c9e: 'XPKeywords',
    0x9c9f: 'XPSubject',
    0xa480: 'GDALMetadata',
    0xa481: 'GDALNoData',
    0xc4a5: 'PrintIM',
    0xc612: 'DNGVersion',
    0xc613: 'DNGBackwardVersion',
    0xc614: 'UniqueCameraModel',
    0xc621: 'ColorMatrix1',
    0xc622: 'ColorMatrix2',
    0xc627: 'AnalogBalance',
    0xc628: 'AsShotNeutral',
    0xc62f: 'CameraSerialNumber',
    0xc630: 'DNGLensInfo',
    0xc634: 'DNGPrivateData',
    0xc65a: 'CalibrationIlluminant1',
    0xc65b: 'CalibrationIlluminant2',
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

const INTEROP_TAGS: Record<number, string> = {
    0x0001: 'InteroperabilityIndex',
    0x0002: 'InteroperabilityVersion',
    0x1000: 'RelatedImageFileFormat',
    0x1001: 'RelatedImageWidth',
    0x1002: 'RelatedImageLength',
};

/** TIFF's compression schemes: the 6.0 ones, and others in common use. */
export const COMPRESSIONS: Record<number, string> = {
    1: 'Uncompressed',
    2: 'CCITT modified Huffman',
    3: 'CCITT Group 3 fax',
    4: 'CCITT Group 4 fax',
    5: 'LZW',
    6: 'JPEG (old-style)',
    7: 'JPEG',
    8: 'Deflate',
    32773: 'PackBits',
    32946: 'Deflate (old code)',
    34712: 'JPEG 2000',
    34892: 'Lossy JPEG (DNG)',
};

export const PHOTOMETRICS: Record<number, string> = {
    0: 'WhiteIsZero',
    1: 'BlackIsZero',
    2: 'RGB',
    3: 'Palette',
    4: 'Transparency mask',
    5: 'CMYK',
    6: 'YCbCr',
    8: 'CIE L*a*b*',
    9: 'ICC L*a*b*',
    10: 'ITU L*a*b*',
    32803: 'Color filter array',
    34892: 'Linear raw',
};

const RESOLUTION_UNIT = { 1: 'None', 2: 'Inches', 3: 'Centimeters' };

/** What a tag's number stands for. */
const MEANINGS: Record<string, Record<number, string>> = {
    Compression: COMPRESSIONS,
    PhotometricInterpretation: PHOTOMETRICS,
    NewSubfileType: { 0: 'Full resolution', 1: 'Reduced resolution', 2: 'One page of many', 3: 'Reduced resolution, one page of many', 4: 'Transparency mask' },
    SubfileType: { 1: 'Full resolution', 2: 'Reduced resolution', 3: 'One page of many' },
    Threshholding: { 1: 'None', 2: 'Ordered dither or halftone', 3: 'Error diffusion' },
    FillOrder: { 1: 'Most significant bit first', 2: 'Least significant bit first' },
    Predictor: { 1: 'None', 2: 'Horizontal differencing', 3: 'Floating point' },
    InkSet: { 1: 'CMYK', 2: 'Not CMYK' },
    SampleFormat: { 1: 'Unsigned integer', 2: 'Signed integer', 3: 'Floating point', 4: 'Undefined' },
    ExtraSamples: { 0: 'Unspecified', 1: 'Associated alpha', 2: 'Unassociated alpha' },
    GrayResponseUnit: { 1: 'Tenths', 2: 'Hundredths', 3: 'Thousandths', 4: 'Ten-thousandths', 5: 'Hundred-thousandths' },
    JPEGProc: { 1: 'Baseline', 14: 'Lossless' },
    Orientation: {
        1: 'Normal',
        2: 'Mirrored',
        3: 'Rotated 180°',
        4: 'Mirrored vertically',
        5: 'Mirrored and rotated 270° clockwise',
        6: 'Rotated 90° clockwise',
        7: 'Mirrored and rotated 90° clockwise',
        8: 'Rotated 270° clockwise',
    },
    ResolutionUnit: RESOLUTION_UNIT,
    FocalPlaneResolutionUnit: RESOLUTION_UNIT,
    YCbCrPositioning: { 1: 'Centered', 2: 'Co-sited' },
    PlanarConfiguration: { 1: 'Chunky', 2: 'Planar' },
    ColorSpace: { 1: 'sRGB', 0xffff: 'Uncalibrated' },
    ExposureProgram: {
        0: 'Not defined',
        1: 'Manual',
        2: 'Normal program',
        3: 'Aperture priority',
        4: 'Shutter priority',
        5: 'Creative program',
        6: 'Action program',
        7: 'Portrait mode',
        8: 'Landscape mode',
    },
    MeteringMode: { 0: 'Unknown', 1: 'Average', 2: 'Center-weighted average', 3: 'Spot', 4: 'Multi-spot', 5: 'Pattern', 6: 'Partial', 255: 'Other' },
    LightSource: {
        0: 'Unknown',
        1: 'Daylight',
        2: 'Fluorescent',
        3: 'Tungsten',
        4: 'Flash',
        9: 'Fine weather',
        10: 'Cloudy',
        11: 'Shade',
        17: 'Standard light A',
        18: 'Standard light B',
        19: 'Standard light C',
        20: 'D55',
        21: 'D65',
        22: 'D75',
        23: 'D50',
        24: 'ISO studio tungsten',
        255: 'Other',
    },
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
const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4];
const TYPE_NAME = ['', 'BYTE', 'ASCII', 'SHORT', 'LONG', 'RATIONAL', 'SBYTE', 'UNDEFINED', 'SSHORT', 'SLONG', 'SRATIONAL', 'FLOAT', 'DOUBLE', 'IFD'];

/** Undefined-type tags that hold four ASCII digits. */
const VERSIONS = new Set(['ExifVersion', 'FlashpixVersion', 'InteroperabilityVersion']);

/** At most this many values are listed; longer arrays are summed up. */
const MAX_VALUES = 16;

/** Where one entry's values are. */
export interface IfdEntry {
    type: number;
    count: number;
    /** The first value's offset in the data: in the entry, or where its offset points. */
    at: number;
}

/** A directory of a picture (a page, a thumbnail, a SubIFD), by tag number. */
export interface Ifd {
    name: string;
    offset: number;
    entries: Map<number, IfdEntry>;
}

export interface Tiff {
    little: boolean;
    fields: Field[];
    /** Every tag read, by name: its first value (a number, or the text). The first picture's tags win over later ones'. */
    tags: Map<string, number | string>;
    /** The directories that describe pictures: the chain in order, then SubIFDs. */
    images: Ifd[];
    /** The GPS position in degrees, when it's there. */
    position?: [number, number];
    /** The EXIF thumbnail (IFD1's JPEG), as absolute offsets. */
    thumbnail?: { offset: number; length: number };
    /** Every value of an entry, as numbers (rationals divided out). */
    values(entry: IfdEntry | undefined): number[];
    warnings: string[];
}

/** For EXIF: the structure inside an APP1 segment, where IFD1 is the thumbnail. */
export const readExif = (data: Uint8Array, base: number, end: number) => readTiff(data, base, end, 'exif');

/** Reads the TIFF structure starting at `base` (the byte order mark) and ending by `end`. */
export function readTiff(data: Uint8Array, base: number, end: number, mode: 'exif' | 'file'): Tiff {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const little = data[base] === 0x49;
    const inside = (at: number, length: number) => at >= base && at + length <= end;
    const u16 = (at: number) => (inside(at, 2) ? view.getUint16(at, little) : 0);
    const u32 = (at: number) => (inside(at, 4) ? view.getUint32(at, little) : 0);
    const rationals = new Map<string, number[]>();
    const visited = new Set<number>();

    /** One value of a tag, as a number. */
    const number = (type: number, at: number): number => {
        switch (type) {
            case 1:
            case 2:
            case 7: return data[at]; // prettier-ignore
            case 3:
                return u16(at);
            case 4:
            case 13: return u32(at); // prettier-ignore
            case 6:
                return (data[at] << 24) >> 24;
            case 8:
                return (u16(at) << 16) >> 16;
            case 9:
                return view.getInt32(at, little);
            case 5: { const d = u32(at + 4); return d ? u32(at) / d : 0; } // prettier-ignore
            case 10: { const d = view.getInt32(at + 4, little); return d ? view.getInt32(at, little) / d : 0; } // prettier-ignore
            case 11:
                return view.getFloat32(at, little);
            case 12:
                return view.getFloat64(at, little);
        }
        return 0;
    };
    const values = (entry: IfdEntry | undefined): number[] => {
        if (!entry || !TYPE_SIZE[entry.type] || !inside(entry.at, entry.count * TYPE_SIZE[entry.type])) return [];
        return Array.from({ length: entry.count }, (_, k) => number(entry.type, entry.at + k * TYPE_SIZE[entry.type]));
    };
    const out: Tiff = { little, fields: [], tags: new Map(), images: [], values, warnings: [] };
    const remember = (tag: string, value: number | string) => out.tags.has(tag) || out.tags.set(tag, value);

    out.fields.push({
        name: 'TIFF header',
        offset: base,
        length: 8,
        children: [
            field('Byte order', base, 2, little ? 'II (little-endian)' : 'MM (big-endian)'),
            field('Magic', base + 2, 2, u16(base + 2), 'Always 42.'),
            field('IFD0 offset', base + 4, 4, u32(base + 4)),
        ],
    });

    const rational = (type: number, at: number): string => {
        const [n, d] = type === 5 ? [u32(at), u32(at + 4)] : [view.getInt32(at, little), view.getInt32(at + 4, little)];
        if (d === 0) return 'undefined';
        if (n % d === 0) return String(n / d);
        // Exposure times read best as a fraction of a second.
        if (n === 1 || (n > 0 && d % n === 0 && n < d)) return `1/${d / n}`;
        return String(+(n / d).toPrecision(6));
    };

    /** Reads one IFD and those it points to; returns the next one's offset (0 at the end of the chain). */
    const readIfd = (name: string, at: number, names: Record<number, string>, image: boolean): number => {
        if (!inside(at, 2) || visited.has(at)) return 0;
        visited.add(at);
        const count = u16(at);
        const children: Field[] = [field('Entry count', at, 2, count)];
        const pointers: [string, number, Record<number, string>, boolean][] = [];
        const ifd: Ifd = { name, offset: at, entries: new Map() };
        if (image) out.images.push(ifd);
        for (let i = 0; i < count; i++) {
            const entry = at + 2 + i * 12;
            if (!inside(entry, 12)) {
                out.warnings.push(`${name} runs past the end of the ${mode === 'exif' ? 'EXIF data' : 'file'}.`);
                break;
            }
            const id = u16(entry);
            const type = u16(entry + 2);
            const n = u32(entry + 4);
            const size = (TYPE_SIZE[type] ?? 0) * n;
            const valueAt = size <= 4 ? entry + 8 : base + u32(entry + 8);
            ifd.entries.set(id, { type, count: n, at: valueAt });
            const tag = names[id] ?? TIFF_TAGS[id] ?? `Tag 0x${hex(id, 4)}`;
            const what = `${TYPE_NAME[type] ?? `type ${type}`} × ${n}`;
            let value: string;
            if (!TYPE_SIZE[type] || !inside(valueAt, size)) {
                value = size && TYPE_SIZE[type] ? 'Out of range' : 'Unknown type';
            } else if (type === 2) {
                let text = '';
                for (let k = 0; k < n && data[valueAt + k]; k++) text += String.fromCharCode(data[valueAt + k]);
                value = text.trim();
                remember(tag, value);
            } else if (type === 7 && VERSIONS.has(tag)) {
                value = String.fromCharCode(...data.subarray(valueAt, valueAt + Math.min(n, 4)));
            } else if (type === 7 && tag === 'UserComment') {
                const charset = String.fromCharCode(...data.subarray(valueAt, valueAt + 8)).replace(/\0+$/, '');
                const text =
                    charset === 'ASCII'
                        ? new TextDecoder('latin1')
                              .decode(data.subarray(valueAt + 8, valueAt + n))
                              .replace(/\0+$/, '')
                              .trim()
                        : '';
                value = text || (charset ? `${charset} text` : bytesLabel(n));
            } else if (type === 1 && tag.startsWith('XP')) {
                // Windows' tags: UTF-16LE text in bytes.
                value = new TextDecoder('utf-16le').decode(data.subarray(valueAt, valueAt + n)).replace(/\0+$/, '');
            } else if ((type === 7 || type === 1) && n > MAX_VALUES) {
                value = bytesLabel(n);
            } else if (type === 7) {
                value = Array.from(data.subarray(valueAt, valueAt + n), (b) => hex(b, 2)).join(' ');
            } else {
                const shown: string[] = [];
                const numbers: number[] = [];
                for (let k = 0; k < Math.min(n, MAX_VALUES); k++) {
                    const at = valueAt + k * TYPE_SIZE[type];
                    numbers.push(number(type, at));
                    shown.push(type === 5 || type === 10 ? rational(type, at) : String(+number(type, at).toPrecision(7)));
                }
                if ((type === 5 || type === 10) && !rationals.has(tag)) rationals.set(tag, numbers);
                remember(tag, numbers[0]);
                const meaning = n === 1 ? (tag === 'Flash' ? flash(numbers[0]) : MEANINGS[tag]?.[numbers[0]]) : undefined;
                value = meaning ? `${shown[0]} (${meaning})` : shown.join(', ') + (n > MAX_VALUES ? `, … (${n} in all)` : '');
                if (tag === 'ExifIFDPointer') pointers.push(['Exif IFD', base + numbers[0], EXIF_TAGS, false]);
                if (tag === 'GPSInfoIFDPointer') pointers.push(['GPS IFD', base + numbers[0], GPS_TAGS, false]);
                if (tag === 'InteroperabilityIFDPointer') pointers.push(['Interoperability IFD', base + numbers[0], INTEROP_TAGS, false]);
                // SubIFDs: more pictures of this one (a DNG's raw data, smaller previews).
                if (tag === 'SubIFDs') values({ type, count: n, at: valueAt }).forEach((o, k) => pointers.push([`${name} › SubIFD ${k + 1}`, base + o, TIFF_TAGS, true]));
            }
            const note = tag === 'MakerNote' ? "In the camera maker's own format." : undefined;
            // The entry's four parts, and the value where it's stored: in the entry when it fits in 4 bytes, else at its offset.
            const parts = [
                field('Tag', entry, 2, `0x${hex(id, 4)}`),
                field('Type', entry + 2, 2, `${type} (${TYPE_NAME[type] || 'unknown'})`),
                field('Count', entry + 4, 4, n, 'Values, not bytes.'),
                size <= 4
                    ? field('Value', entry + 8, 4, value, size < 4 ? 'Left-aligned; the rest is padding.' : undefined)
                    : field('Value offset', entry + 8, 4, u32(entry + 8), 'From the TIFF header.'),
                ...(size > 4 ? [field('Value', valueAt, size, value)] : []),
            ];
            children.push({ name: tag, offset: entry, length: 12, value, note: [note, `${what}.`].filter(Boolean).join(' '), children: parts });
        }
        const next = at + 2 + count * 12;
        children.push(field('Next IFD offset', next, 4, u32(next)));
        out.fields.push({ name, offset: at, length: 2 + count * 12 + 4, children });
        for (const [label, offset, table, isImage] of pointers) readIfd(label, offset, table, isImage);
        return u32(next);
    };

    // The chain: a TIFF file's pages, or EXIF's picture and thumbnail.
    let next = u32(base + 4);
    for (let page = 0; next && page < 4096; page++) {
        const name = mode === 'exif' && page === 1 ? 'IFD1 (thumbnail)' : `IFD${page}`;
        next = readIfd(name, base + next, TIFF_TAGS, true);
    }

    // EXIF's thumbnail is a JPEG of its own.
    const ifd1 = mode === 'exif' ? out.images.find((i) => i.name === 'IFD1 (thumbnail)') : undefined;
    const [offset] = values(ifd1?.entries.get(0x0201));
    const [length] = values(ifd1?.entries.get(0x0202));
    if (offset !== undefined && length > 0 && inside(base + offset, length)) {
        out.thumbnail = { offset: base + offset, length };
        out.fields.push(field('Thumbnail', base + offset, length, bytesLabel(length), 'A JPEG of its own.'));
    }

    const lat = rationals.get('GPSLatitude');
    const lon = rationals.get('GPSLongitude');
    if (lat?.length === 3 && lon?.length === 3) {
        const degrees = ([d, m, s]: number[], negative: boolean) => (negative ? -1 : 1) * (d + m / 60 + s / 3600);
        out.position = [degrees(lat, out.tags.get('GPSLatitudeRef') === 'S'), degrees(lon, out.tags.get('GPSLongitudeRef') === 'W')];
    }
    return out;
}

/** The headline facts EXIF gives: the camera, when, the exposure, where. */
export function exifSummary(exif: Tiff): [string, string][] {
    const t = exif.tags;
    const out: [string, string][] = [];
    const camera = [t.get('Make'), t.get('Model')].filter((v) => typeof v === 'string' && v) as string[];
    // Models often repeat the make ("Canon" "Canon EOS 40D").
    if (camera.length) out.push(['Camera', camera.length === 2 && camera[1].toLowerCase().startsWith(camera[0].toLowerCase()) ? camera[1] : camera.join(' ')]);
    const taken = t.get('DateTimeOriginal') ?? t.get('DateTime');
    if (typeof taken === 'string' && taken) out.push(['Taken', taken.replace(/^(\d{4}):(\d\d):(\d\d)/, '$1-$2-$3')]);
    const exposure: string[] = [];
    const time = t.get('ExposureTime');
    if (typeof time === 'number' && time > 0) exposure.push(time < 1 ? `1/${Math.round(1 / time)} s` : `${+time.toPrecision(3)} s`);
    const f = t.get('FNumber');
    if (typeof f === 'number' && f > 0) exposure.push(`f/${+f.toPrecision(3)}`);
    const iso = t.get('ISOSpeedRatings');
    if (typeof iso === 'number' && iso > 0) exposure.push(`ISO ${iso}`);
    const focal = t.get('FocalLength');
    if (typeof focal === 'number' && focal > 0) exposure.push(`${+focal.toPrecision(4)} mm`);
    if (exposure.length) out.push(['Exposure', exposure.join(', ')]);
    const orientation = t.get('Orientation');
    if (typeof orientation === 'number' && orientation > 1)
        out.push([
            'Orientation',
            ['', '', 'Mirrored', 'Rotated 180°', 'Mirrored vertically', 'Mirrored, rotated 270°', 'Rotated 90° clockwise', 'Mirrored, rotated 90°', 'Rotated 270° clockwise'][orientation] ??
                String(orientation),
        ]);
    if (exif.position) out.push(['GPS', exif.position.map((d) => d.toFixed(6)).join(', ')]);
    return out;
}

/** The Flash tag's bits: fired, the strobe's return, the mode, red-eye. */
function flash(v: number): string {
    if (v & 0x20) return 'No flash';
    const parts = [v & 1 ? 'Fired' : "Didn't fire"];
    const mode = (v >> 3) & 3;
    if (mode) parts.push(['', 'compulsory', 'suppressed', 'auto'][mode]);
    if (v & 0x40) parts.push('red-eye reduction');
    return parts.join(', ');
}
