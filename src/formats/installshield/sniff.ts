/** InstallShield 3 archives (.z, .lib): 13 5D 65 8C, then 3A 01 02 00. Kept apart from the reader so the sniffers don't load it. */
export const IS3_SIGNATURE = [0x13, 0x5d, 0x65, 0x8c, 0x3a, 0x01, 0x02, 0x00];

export function sniffInstallShieldZ(data: Uint8Array): boolean {
    return data.length >= IS3_SIGNATURE.length && IS3_SIGNATURE.every((v, i) => data[i] === v);
}

/** The 10 bytes before an InstallShield 3 package list's first block. */
export const PKG_HEADER = 10;

/**
 * InstallShield 3's package lists (SETUP.PKG): 4A A3, then where the list of archives is, after at least one block;
 * that list has to hold an archive, whose entry fits in the file. Two bytes are too few to go on alone.
 */
export function sniffInstallShieldPkg(data: Uint8Array): boolean {
    if (data.length < PKG_HEADER + 4 || data[0] !== 0x4a || data[1] !== 0xa3) return false;
    const listAt = (data[2] | (data[3] << 8) | (data[4] << 16) | (data[5] << 24)) >>> 0;
    if (listAt < PKG_HEADER + 4 || listAt + 8 > data.length) return false;
    const count = data[listAt + 4] | (data[listAt + 5] << 8);
    const name = data[listAt + 6] | (data[listAt + 7] << 8);
    return count > 0 && listAt + 6 + 8 + name <= data.length;
}
