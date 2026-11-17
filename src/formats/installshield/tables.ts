import { sniffInstallShieldZ } from './sniff';

/**
 * What an InstallShield 3 archive says it holds, from its directory and file tables alone, without unpacking
 * anything: for a package list (pkg.ts) to check itself against. The archive's reader (index.ts) reads the same tables
 * with every field and warning; this only takes what agrees with itself, and stops at what doesn't.
 */

export interface ArchiveFile {
    name: string;
    /** Its directory's name, '' for the top. */
    directory: string;
    size: number;
    packed: number;
}

/** The directories and files an archive lists, or null when its tables can't be read. */
export function archiveTables(data: Uint8Array): { directories: string[]; files: ArchiveFile[] } | null {
    if (!sniffInstallShieldZ(data) || data.length < 59) return null;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const u16 = (at: number) => view.getUint16(at, true);
    const u32 = (at: number) => view.getUint32(at, true);
    const latin1 = (at: number, length: number) => new TextDecoder('latin1').decode(data.subarray(at, at + length));
    const [fileCount, dirsAt, dirsSize, dirCount, filesAt, filesSize] = [u16(12), u32(41), u32(45), u16(49), u32(51), u32(55)];
    if (dirsAt + dirsSize > data.length || filesAt + filesSize > data.length) return null;

    const directories: string[] = [];
    let at = dirsAt;
    for (let i = 0; i < dirCount; i++) {
        if (at + 6 > dirsAt + dirsSize) return null;
        const [size, length] = [u16(at + 2), u16(at + 4)];
        if (size < 6 + length || at + size > dirsAt + dirsSize) return null;
        directories.push(latin1(at + 6, length));
        at += size;
    }
    const files: ArchiveFile[] = [];
    at = filesAt;
    for (let i = 0; i < fileCount; i++) {
        if (at + 30 > filesAt + filesSize) return null;
        const [entry, length] = [u16(at + 23), data[at + 29]];
        if (entry < 30 + length || at + entry > filesAt + filesSize) return null;
        files.push({ name: latin1(at + 30, length), directory: directories[u16(at + 1)] ?? '', size: u32(at + 3), packed: u32(at + 7) });
        at += entry;
    }
    return { directories, files };
}
