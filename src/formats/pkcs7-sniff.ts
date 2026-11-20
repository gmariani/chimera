/**
 * Signatures and certificates in DER (see pkcs7.ts). Kept apart from the reader so the sniffers don't load it.
 *
 * - Signed data (PKCS #7): a SEQUENCE that starts with signed data's object identifier, 1.2.840.113549.1.7.2; or, as
 *   the first Authenticode signatures are, the signed data alone, its content Authenticode's; or the signed data alone
 *   holding plain data and certificates, a bag of certificates (Internet Explorer 3's softpub.dll keeps one).
 * - A certificate (X.509): a SEQUENCE holding a SEQUENCE that starts with its version, [0] holding a small INTEGER, as
 *   every certificate since version 2 does; or, version 1 (with no version written), its serial number and the
 *   SEQUENCE of its signature's algorithm. It runs to the end of the file.
 */

/** A SEQUENCE's header at `at`: where its contents start and its length, or null. */
function sequence(data: Uint8Array, at: number): { contentAt: number; length: number } | null {
    if (data[at] !== 0x30) return null;
    const first = data[at + 1];
    if (first < 0x80) return { contentAt: at + 2, length: first };
    const n = first & 0x7f;
    if (n < 1 || n > 3) return null;
    let length = 0;
    for (let i = 0; i < n; i++) length = length * 256 + data[at + 2 + i];
    return { contentAt: at + 2 + n, length };
}

const SIGNED_DATA = [0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02];

/** Plain data's content type, 1.2.840.113549.1.7.1. */
const DATA = [0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x01];

/** Authenticode's content type, 1.3.6.1.4.1.311.2.1.4. */
const AUTHENTICODE = [0x06, 0x0a, 0x2b, 0x06, 0x01, 0x04, 0x01, 0x82, 0x37, 0x02, 0x01, 0x04];

export function sniffPkcs7(data: Uint8Array): boolean {
    const outer = sequence(data, 0);
    if (!outer || outer.contentAt + outer.length > data.length) return false;
    const c = outer.contentAt;
    if (SIGNED_DATA.every((v, i) => data[c + i] === v)) return true;
    // The signed data alone (its version, the hash algorithms, then what it holds): the first Authenticode's, or a bag
    // of certificates, which holds plain data and has its certificates ([0]) next.
    if (data[c] !== 0x02 || data[c + 1] !== 1 || data[c + 3] !== 0x31 || data[c + 4] > 0x7f) return false;
    const contentAt = c + 5 + data[c + 4];
    const content = sequence(data, contentAt);
    if (!content) return false;
    if (AUTHENTICODE.every((v, i) => data[content.contentAt + i] === v)) return true;
    return content.length === DATA.length && DATA.every((v, i) => data[content.contentAt + i] === v) && data[content.contentAt + content.length] === 0xa0;
}

export function sniffCertificate(data: Uint8Array): boolean {
    const outer = sequence(data, 0);
    if (!outer || outer.contentAt + outer.length !== data.length) return false;
    const tbs = sequence(data, outer.contentAt);
    if (!tbs) return false;
    const v = tbs.contentAt;
    if (data[v] === 0xa0) return data[v + 1] === 3 && data[v + 2] === 0x02 && data[v + 3] === 1 && data[v + 4] <= 2;
    // Version 1: the serial number (at most 20 bytes, and a sign byte), then the algorithm: a SEQUENCE starting with an OID.
    if (data[v] !== 0x02 || data[v + 1] < 1 || data[v + 1] > 21) return false;
    const algorithm = sequence(data, v + 2 + data[v + 1]);
    return !!algorithm && data[algorithm.contentAt] === 0x06 && algorithm.contentAt + algorithm.length <= tbs.contentAt + tbs.length;
}
