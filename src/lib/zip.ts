import { crc32 } from '../core/crc32';

/**
 * A ZIP of stored (uncompressed) files, built as a Blob so the file data is
 * never copied into one big buffer. No ZIP64, so the total must stay under 4 GB.
 */
export function zip(files: { name: string; data: Uint8Array }[]): Blob {
    const parts: BlobPart[] = [];
    const central: Uint8Array[] = [];
    let offset = 0;
    const used = new Set<string>();
    // Stamp every file with the time of extraction, in MS-DOS format.
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

    for (const file of files) {
        const name = unique(file.name, used);
        const nameBytes = new TextEncoder().encode(name);
        const crc = crc32(file.data);
        const size = file.data.length;

        const local = new Uint8Array(30 + nameBytes.length);
        const l = new DataView(local.buffer);
        l.setUint32(0, 0x04034b50, true);
        l.setUint16(4, 20, true); // version needed
        l.setUint16(6, 0x0800, true); // UTF-8 names
        l.setUint16(8, 0, true); // stored
        l.setUint16(10, dosTime, true);
        l.setUint16(12, dosDate, true);
        l.setUint32(14, crc, true);
        l.setUint32(18, size, true);
        l.setUint32(22, size, true);
        l.setUint16(26, nameBytes.length, true);
        local.set(nameBytes, 30);

        const entry = new Uint8Array(46 + nameBytes.length);
        const c = new DataView(entry.buffer);
        c.setUint32(0, 0x02014b50, true);
        c.setUint16(4, 20, true);
        c.setUint16(6, 20, true);
        c.setUint16(8, 0x0800, true);
        c.setUint16(12, dosTime, true);
        c.setUint16(14, dosDate, true);
        c.setUint32(16, crc, true);
        c.setUint32(20, size, true);
        c.setUint32(24, size, true);
        c.setUint16(28, nameBytes.length, true);
        c.setUint32(42, offset, true);
        entry.set(nameBytes, 46);
        central.push(entry);

        parts.push(local, file.data as Uint8Array<ArrayBuffer>);
        offset += local.length + size;
        if (offset > 0xffffffff) throw new Error('That is more than 4 GB, which is too big for a ZIP without ZIP64.');
    }

    const centralSize = central.reduce((n, e) => n + e.length, 0);
    const end = new Uint8Array(22);
    const e = new DataView(end.buffer);
    e.setUint32(0, 0x06054b50, true);
    e.setUint16(8, files.length, true);
    e.setUint16(10, files.length, true);
    e.setUint32(12, centralSize, true);
    e.setUint32(16, offset, true);

    return new Blob([...parts, ...(central as Uint8Array<ArrayBuffer>[]), end], { type: 'application/zip' });
}

function unique(name: string, used: Set<string>): string {
    let candidate = name;
    for (let n = 2; used.has(candidate.toLowerCase()); n++) {
        const dot = name.lastIndexOf('.');
        candidate = dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
    }
    used.add(candidate.toLowerCase());
    return candidate;
}
