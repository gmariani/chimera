import { bytesLabel, field } from '../core/bytes';
import type { Field, FormatParser, TableRow } from '../core/types';
import { BIT_STRING, hexText, INTEGER, OCTET_STRING, OID, oidText, readTlv, SEQUENCE, SET, stringText, tagName, timeText, type Tlv } from './der';

/**
 * Signatures and certificates: PKCS #7 (Cryptographic Message Syntax) signed data, as Windows programs carry their
 * Authenticode signature, and X.509 certificates on their own (.cer, .crt, .der), all in DER (see der.ts).
 *
 * A signature is a ContentInfo: what it holds (signed data), then the signed data: the hash algorithms it uses, what
 * was signed (for Authenticode, the program's hash), the certificates, and a SignerInfo for each signer, saying which
 * certificate is theirs, what they vouched for (the signed attributes: the hash of what was signed, when, the
 * program's name and web address) and their signature. A timestamp, a third party's signature saying when, is kept
 * in the signer's unsigned attributes, as is any further signature (with another hash algorithm).
 *
 * A certificate says who (the subject) holds a public key, signed by whoever vouches for it (the issuer), from when
 * to when, and what for (its extensions: whether it may vouch for others, what the key may sign).
 *
 * Nothing here checks a signature or a certificate: it says what they say. See RFC 5652 (CMS), RFC 5280 (X.509
 * certificates), RFC 3161 (timestamps), and Microsoft's "Windows Authenticode Portable Executable Signature Format"
 * (https://learn.microsoft.com/windows-hardware/drivers/install/authenticode) for what Authenticode adds.
 */

/** Object identifiers, in words. */
const OIDS: Record<string, string> = {
    '1.2.840.113549.1.7.1': 'data',
    '1.2.840.113549.1.7.2': 'signed data',
    '1.2.840.113549.1.1.1': 'RSA',
    '1.2.840.113549.1.1.2': 'MD2 with RSA',
    '1.2.840.113549.1.1.4': 'MD5 with RSA',
    '1.2.840.113549.2.2': 'MD2',
    '1.2.840.113549.1.1.5': 'SHA-1 with RSA',
    '1.2.840.113549.1.1.10': 'RSA-PSS',
    '1.2.840.113549.1.1.11': 'SHA-256 with RSA',
    '1.2.840.113549.1.1.12': 'SHA-384 with RSA',
    '1.2.840.113549.1.1.13': 'SHA-512 with RSA',
    '1.2.840.10045.2.1': 'elliptic curve',
    '1.2.840.10045.4.3.2': 'ECDSA with SHA-256',
    '1.2.840.10045.4.3.3': 'ECDSA with SHA-384',
    '1.2.840.10045.4.3.4': 'ECDSA with SHA-512',
    '1.2.840.10045.3.1.7': 'P-256',
    '1.3.132.0.34': 'P-384',
    '1.3.132.0.35': 'P-521',
    '1.2.840.113549.2.5': 'MD5',
    '1.3.14.3.2.26': 'SHA-1',
    '2.16.840.1.101.3.4.2.1': 'SHA-256',
    '2.16.840.1.101.3.4.2.2': 'SHA-384',
    '2.16.840.1.101.3.4.2.3': 'SHA-512',
    '2.5.4.3': 'common name',
    '2.5.4.4': 'surname',
    '2.5.4.5': 'serial number',
    '2.5.4.6': 'country',
    '2.5.4.7': 'locality',
    '2.5.4.8': 'state or province',
    '2.5.4.9': 'street',
    '2.5.4.10': 'organization',
    '2.5.4.11': 'organizational unit',
    '2.5.4.15': 'business category',
    '2.5.4.17': 'postal code',
    '1.3.6.1.4.1.311.60.2.1.2': 'state of incorporation',
    '1.3.6.1.4.1.311.60.2.1.3': 'country of incorporation',
    '1.2.840.113549.1.9.1': 'email',
    '1.2.840.113549.1.9.3': 'content type',
    '1.2.840.113549.1.9.4': 'message digest',
    '1.2.840.113549.1.9.5': 'signing time',
    '1.2.840.113549.1.9.6': 'countersignature',
    '1.2.840.113549.1.9.15': 'S/MIME capabilities',
    '1.2.840.113549.1.9.16.1.4': 'timestamp information',
    '1.2.840.113549.1.9.16.2.12': 'signing certificate',
    '1.2.840.113549.1.9.16.2.47': 'signing certificate (v2)',
    '2.5.29.14': 'subject key identifier',
    '2.5.29.15': 'key usage',
    '2.5.29.17': 'subject alternative name',
    '2.5.29.19': 'basic constraints',
    '2.5.29.31': 'CRL distribution points',
    '2.5.29.32': 'certificate policies',
    '2.5.29.35': 'authority key identifier',
    '2.5.29.37': 'extended key usage',
    '1.3.6.1.5.5.7.1.1': 'authority information access',
    '1.3.6.1.5.5.7.3.1': 'server authentication',
    '1.3.6.1.5.5.7.3.2': 'client authentication',
    '1.3.6.1.5.5.7.3.3': 'code signing',
    '1.3.6.1.5.5.7.3.4': 'email protection',
    '1.3.6.1.5.5.7.3.8': 'timestamping',
    '1.3.6.1.4.1.311.2.1.4': 'Authenticode: what was signed',
    '1.3.6.1.4.1.311.2.1.11': 'Authenticode: statement type',
    '1.3.6.1.4.1.311.2.1.12': 'Authenticode: program name and web address',
    '1.3.6.1.4.1.311.2.1.15': 'Authenticode: a program (PE)',
    '1.3.6.1.4.1.311.2.1.21': 'individual code signing',
    '1.3.6.1.4.1.311.2.1.22': 'commercial code signing',
    '1.3.6.1.4.1.311.2.4.1': 'another signature',
    '1.3.6.1.4.1.311.3.3.1': 'timestamp (RFC 3161)',
    '1.3.6.1.4.1.311.10.3.13': 'lifetime signing',
};
const oidName = (oid: string) => OIDS[oid] ?? oid;

/** The parts of a name, in the order people read them, by their short form. */
const NAME_ORDER = ['2.5.4.3', '2.5.4.11', '2.5.4.10', '2.5.4.7', '2.5.4.8', '2.5.4.6'];

interface Certificate {
    tlv: Tlv;
    subject: [string, string][];
    issuer: [string, string][];
    serial: string;
    from: string;
    to: string;
    key: string;
    signedWith: string;
    usage: string[];
    authority: boolean | null;
}

interface Signer {
    issuer: [string, string][];
    serial: string;
    hash: string;
    signedAt?: string;
    program?: string;
    url?: string;
    timestamp?: { at: string; by: string };
}

export interface SignatureInfo {
    /** What it is: "Authenticode signature", "PKCS #7 signed data", "X.509 certificate". */
    what: string;
    certificates: Certificate[];
    signers: Signer[];
    /** For Authenticode, the hash of the program, and with what. */
    digest?: { algorithm: string; value: string };
    /** How many signatures it holds, counting those nested in the first. */
    signatures: number;
    fields: Field[];
    end: number;
    problems: string[];
}

/** A name ("CN=…, O=…") as its parts. */
function readName(data: Uint8Array, t: Tlv | undefined): [string, string][] {
    const out: [string, string][] = [];
    for (const rdn of t?.children ?? [])
        for (const atv of rdn.children ?? []) if (atv.children?.length === 2 && atv.children[0].tag === OID) out.push([oidText(data, atv.children[0]), stringText(data, atv.children[1])]);
    return out;
}

/** A name in words: its common name (or organization), then the rest. */
export function nameText(name: [string, string][], full = false): string {
    const get = (oid: string) => name.filter(([k]) => k === oid).map(([, v]) => v);
    const main = get('2.5.4.3')[0] ?? get('2.5.4.10')[0] ?? name[0]?.[1] ?? '(no name)';
    if (!full) return main;
    const rest = NAME_ORDER.flatMap((oid) => get(oid)).filter((v, i, all) => v !== main && all.indexOf(v) === i);
    return rest.length ? `${main} (${rest.join(', ')})` : main;
}

/** An INTEGER's contents in hex, without the leading zero DER adds to keep it positive. */
const integerHex = (data: Uint8Array, t: Tlv) => hexText(data, t.contentAt + (data[t.contentAt] === 0 && t.end - t.contentAt > 1 ? 1 : 0), t.end);

/**
 * Reads a signature (PKCS #7 signed data) or a certificate starting at `at`, within `end`. Throws when it isn't DER, or
 * isn't either. Every value read is a field, named for what it is where it's known.
 */
export function readSignature(data: Uint8Array, at: number, end: number): SignatureInfo {
    const root = readTlv(data, at, end);
    const labels = new Map<Tlv, { name: string; value?: string; note?: string }>();
    const label = (t: Tlv | undefined, name: string, value?: string, note?: string) => t && labels.set(t, { name, value, note });
    const problems: string[] = [];
    const certificates: Certificate[] = [];
    const signers: Signer[] = [];
    let digest: SignatureInfo['digest'];
    let signatures = 0;
    const oidOf = (t: Tlv | undefined) => (t?.tag === OID ? oidText(data, t) : '');
    const algorithm = (t: Tlv | undefined, name: string) => {
        const oid = oidOf(t?.children?.[0]);
        label(t, name, oidName(oid));
        return oidName(oid);
    };

    const readCertificate = (t: Tlv, n: number): Certificate | null => {
        const tbs = t.children?.[0];
        if (t.tag !== SEQUENCE || tbs?.tag !== SEQUENCE || !tbs.children) return null;
        const parts = tbs.children;
        let i = 0;
        let version = 1;
        if (parts[0]?.tag === 0xa0) {
            version = (parts[0].children?.[0] ? data[parts[0].children[0].end - 1] : 0) + 1;
            label(parts[0], 'Version', String(version));
            i = 1;
        }
        const [serial, sigAlg, issuer, validity, subject, spki] = parts.slice(i, i + 6);
        if (serial?.tag !== INTEGER || validity?.tag !== SEQUENCE || spki?.tag !== SEQUENCE) return null;
        const c: Certificate = {
            tlv: t,
            subject: readName(data, subject),
            issuer: readName(data, issuer),
            serial: integerHex(data, serial),
            from: validity.children?.[0] ? timeText(data, validity.children[0]) : '',
            to: validity.children?.[1] ? timeText(data, validity.children[1]) : '',
            key: '',
            signedWith: algorithm(t.children?.[1], 'Signed with'),
            usage: [],
            authority: null,
        };
        label(serial, 'Serial number', c.serial);
        algorithm(sigAlg, 'Signed with');
        label(issuer, 'Issuer', nameText(c.issuer, true), 'Who vouches for it.');
        label(subject, 'Subject', nameText(c.subject, true), 'Whose key it is.');
        label(validity, 'Valid', `${c.from} to ${c.to}`);
        label(validity.children?.[0], 'From', c.from);
        label(validity.children?.[1], 'To', c.to);
        // The key: RSA's size is its modulus's, in bits; an elliptic curve's, the curve's name.
        const keyAlg = oidOf(spki.children?.[0]?.children?.[0]);
        const bits = spki.children?.[1];
        if (keyAlg === '1.2.840.113549.1.1.1' && bits?.tag === BIT_STRING) {
            try {
                const rsa = readTlv(data, bits.contentAt + 1, bits.end);
                const modulus = rsa.children?.[0];
                if (modulus?.tag === INTEGER) {
                    let from = modulus.contentAt;
                    while (from < modulus.end && data[from] === 0) from++;
                    c.key = `RSA, ${(modulus.end - from) * 8 - Math.clz32(data[from]) + 24} bits`;
                }
            } catch {
                c.key = 'RSA';
            }
        } else c.key = keyAlg === '1.2.840.10045.2.1' ? `elliptic curve ${oidName(oidOf(spki.children?.[0]?.children?.[1]))}` : oidName(keyAlg);
        label(spki, 'Public key', c.key);
        // Extensions: what it may do.
        const extensions = parts.find((p) => p.tag === 0xa3);
        label(extensions, 'Extensions');
        for (const ext of extensions?.children?.[0]?.children ?? []) {
            const oid = oidOf(ext.children?.[0]);
            const value = ext.children?.at(-1);
            label(ext, oidName(oid));
            if (value?.tag !== OCTET_STRING) continue;
            try {
                const inner = readTlv(data, value.contentAt, value.end);
                if (oid === '2.5.29.37') c.usage = (inner.children ?? []).map((u) => oidName(oidOf(u)));
                if (oid === '2.5.29.19') c.authority = !!inner.children?.some((x) => x.tag === 0x01 && data[x.contentAt]);
            } catch {
                // An extension's value that isn't DER is said in its bytes, as is.
            }
            if (oid === '2.5.29.37') label(ext, 'Extended key usage', c.usage.join(', '), 'What the key may sign.');
            if (oid === '2.5.29.19') label(ext, 'Basic constraints', c.authority ? 'may vouch for others' : 'may not vouch for others');
        }
        label(tbs, 'What’s signed', `version ${version}`);
        label(t.children?.[2], 'Issuer’s signature', bytesLabel(t.children![2].end - t.children![2].contentAt));
        label(t, `Certificate ${n}`, nameText(c.subject));
        return c;
    };

    /** Signed data, wrapped in its ContentInfo: what's signed, the certificates, the signers; `depth` for those nested in signers' attributes. */
    const readSignedData = (info: Tlv, depth: number, timestamp?: { at?: string }, bare = false) => {
        if (depth > 4) return;
        if (!bare) {
            const type = oidOf(info.children?.[0]);
            label(info.children?.[0], 'Content type', oidName(type));
            if (type !== '1.2.840.113549.1.7.2') {
                if (!depth) throw new Error(`it holds ${oidName(type) || 'something'}, not signed data`);
                return;
            }
            label(info.children?.[1], 'Content');
        }
        signatures++;
        const sd = bare ? info : info.children?.[1]?.children?.[0];
        if (sd?.tag !== SEQUENCE || !sd.children) throw new Error('its signed data isn’t laid out as signed data is');
        label(sd, 'Signed data');
        const [version, algorithms, content] = sd.children;
        label(version, 'Version', version ? String(data[version.end - 1]) : '');
        label(algorithms, 'Hash algorithms', (algorithms?.children ?? []).map((a) => oidName(oidOf(a.children?.[0]))).join(', '));
        // What's signed: Authenticode's says what the program's hash is.
        const contentType = oidOf(content?.children?.[0]);
        label(content, 'What’s signed', oidName(contentType));
        label(content?.children?.[0], 'Content type', oidName(contentType));
        const inner = content?.children?.[1]?.children?.[0];
        if (contentType === '1.3.6.1.4.1.311.2.1.4' && inner?.tag === SEQUENCE) {
            label(inner, 'Authenticode content');
            label(inner.children?.[0], 'What it is', oidName(oidOf(inner.children?.[0]?.children?.[0])));
            const digestInfo = inner.children?.[1];
            const alg = algorithm(digestInfo?.children?.[0], 'Hash algorithm');
            const value = digestInfo?.children?.[1];
            if (value?.tag === OCTET_STRING) {
                label(value, 'Hash of the program', hexText(data, value.contentAt, value.end), 'What Windows compares with the program’s own, to tell it hasn’t changed since.');
                if (!depth) digest = { algorithm: alg, value: hexText(data, value.contentAt, value.end) };
            }
            label(digestInfo, 'Program’s hash', alg);
        } else if (contentType === '1.2.840.113549.1.9.16.1.4' && inner?.tag === OCTET_STRING && timestamp) {
            // A timestamp's: when, in its TSTInfo (version, policy, the hash it stamped, a serial number, the time).
            try {
                const tst = readTlv(data, inner.contentAt, inner.end);
                const genTime = tst.children?.find((x) => x.tag === 0x18);
                if (genTime) timestamp.at = timeText(data, genTime);
                label(inner, 'Timestamp information', timestamp.at);
            } catch {
                problems.push('A timestamp’s information isn’t DER.');
            }
        }
        // Then [0] certificates, [1] revocation lists, and the signers.
        const rest = sd.children.slice(3);
        const certs = rest.find((x) => x.tag === 0xa0);
        const start = certificates.length;
        for (const c of certs?.children ?? []) {
            const read = readCertificate(c, certificates.length + 1);
            if (read) certificates.push(read);
        }
        label(certs, 'Certificates', String(certificates.length - start));
        label(
            rest.find((x) => x.tag === 0xa1),
            'Revocation lists'
        );
        const signerSet = rest.find((x) => x.tag === SET);
        label(signerSet, 'Signers', String(signerSet?.children?.length ?? 0));
        for (const si of signerSet?.children ?? []) {
            const parts = si.children ?? [];
            const sid = parts[1];
            const signer: Signer = { issuer: readName(data, sid?.children?.[0]), serial: sid?.children?.[1]?.tag === INTEGER ? integerHex(data, sid.children[1]) : '', hash: '' };
            label(sid, 'Signer’s certificate', `${nameText(signer.issuer)}’s, serial ${signer.serial}`);
            signer.hash = algorithm(parts[2], 'Hash algorithm');
            for (const set of parts.filter((x) => x.tag === 0xa0 || x.tag === 0xa1)) {
                label(
                    set,
                    set.tag === 0xa0 ? 'Signed attributes' : 'Unsigned attributes',
                    undefined,
                    set.tag === 0xa0 ? 'What the signer vouches for.' : 'Added after signing: timestamps, more signatures.'
                );
                for (const attr of set.children ?? []) {
                    const oid = oidOf(attr.children?.[0]);
                    const value = attr.children?.[1]?.children?.[0];
                    label(attr, oidName(oid));
                    if (oid === '1.2.840.113549.1.9.5' && value) signer.signedAt = timeText(data, value);
                    if (oid === '1.3.6.1.4.1.311.2.1.12' && value) {
                        for (const part of value.children ?? []) {
                            // An SpcString ([0] UTF-16, most significant byte first; [1] ASCII) or an SpcLink ([0] a web address, ASCII).
                            const v = part.children?.[0];
                            const inner = v?.children ? v.children[0] : v;
                            const text = !inner ? '' : part.tag === 0xa0 && inner.tag === 0x80 ? stringText(data, { ...inner, tag: 0x1e }) : stringText(data, inner);
                            if (part.tag === 0xa0) signer.program = text.trim();
                            if (part.tag === 0xa1) signer.url = text.trim();
                        }
                        label(attr, 'Program name and web address', [signer.program, signer.url].filter(Boolean).join(', '));
                    }
                    if (oid === '1.2.840.113549.1.9.6' && value) {
                        // A countersignature: a SignerInfo whose signing time is the timestamp.
                        const issuer = readName(data, value.children?.[1]?.children?.[0]);
                        const time = (value.children ?? []).find((x) => x.tag === 0xa0)?.children?.find((a) => oidOf(a.children?.[0]) === '1.2.840.113549.1.9.5')?.children?.[1]?.children?.[0];
                        const serial = value.children?.[1]?.children?.[1];
                        const by = serial?.tag === INTEGER ? certificates.find((c) => c.serial === integerHex(data, serial)) : undefined;
                        signer.timestamp = { at: time ? timeText(data, time) : '', by: by ? nameText(by.subject) : `someone ${nameText(issuer)} vouched for` };
                        label(attr, 'Timestamp (countersignature)', signer.timestamp.at);
                    }
                    if (oid === '1.3.6.1.4.1.311.3.3.1' && value) {
                        const stamp: { at?: string } = {};
                        readSignedData(value, depth + 1, stamp);
                        // Its signer's certificate may be in the timestamp, or with the program's.
                        const tsSigner = signers.at(-1);
                        signer.timestamp = { at: stamp.at ?? '', by: tsSigner ? nameText(certificates.find((c) => c.serial === tsSigner.serial)?.subject ?? tsSigner.issuer) : '' };
                        signers.pop();
                        label(attr, 'Timestamp (RFC 3161)', signer.timestamp.at);
                    }
                    if (oid === '1.3.6.1.4.1.311.2.4.1') for (const nested of attr.children?.[1]?.children ?? []) readSignedData(nested, depth + 1);
                }
            }
            label(
                parts.find((x) => x.tag === OCTET_STRING),
                'Signature',
                bytesLabel((parts.find((x) => x.tag === OCTET_STRING)?.end ?? 0) - (parts.find((x) => x.tag === OCTET_STRING)?.contentAt ?? 0))
            );
            label(si, 'Signer', nameText(certificates.find((c) => c.serial === signer.serial)?.subject ?? signer.issuer));
            signers.push(signer);
        }
    };

    let what: string;
    // The first Authenticode signatures (1996 and 1997: Internet Explorer 3's and Acrobat Reader 3's installers, in
    // Counterstrike's INTERNET folder) are the signed data alone, version 0, without the ContentInfo around it.
    const bare = root.tag === SEQUENCE && root.children?.[0]?.tag === INTEGER && root.children[1]?.tag === SET && oidOf(root.children[2]?.children?.[0]) === '1.3.6.1.4.1.311.2.1.4';
    if (bare || (root.tag === SEQUENCE && oidOf(root.children?.[0]))) {
        readSignedData(root, 0, undefined, bare);
        what = digest ? `Authenticode signature${bare ? ' (the first kind, 1996–97)' : ''}` : 'Signed data (PKCS #7)';
        if (!bare) label(root, what);
    } else {
        const alone = readCertificate(root, 1);
        if (!alone) throw new Error('it’s neither signed data (PKCS #7) nor a certificate (X.509)');
        certificates.push(alone);
        what = 'Certificate (X.509)';
    }
    for (const s of signers)
        if (!certificates.some((c) => c.serial === s.serial))
            problems.push(`The certificate of the signer ${nameText(s.issuer)} vouched for (serial ${s.serial}) isn’t in it: what signed it can’t be told from it.`);

    // Every value as a field, named for what it is where that's known.
    const toField = (t: Tlv): Field => {
        const l = labels.get(t);
        let value = l?.value;
        if (value === undefined && !t.children) {
            const n = t.end - t.contentAt;
            const kind = t.tag & 0x1f;
            if (t.tag === OID) value = oidName(oidText(data, t));
            else if (t.tag === INTEGER) value = n <= 6 ? String(Number.parseInt(hexText(data, t.contentAt, t.end) || '0', 16)) : integerHex(data, t);
            else if (t.tag < 0x40 && [12, 19, 20, 22, 26, 30].includes(kind)) value = stringText(data, t);
            else if (t.tag === 0x17 || t.tag === 0x18) value = timeText(data, t);
            else if (t.tag === 0x05) value = '';
            else value = n <= 32 ? hexText(data, t.contentAt, t.end, true) : bytesLabel(n);
        }
        return { ...field(l?.name ?? tagName(t.tag), t.at, t.end - t.at, value, l?.note), ...(t.children?.length ? { children: t.children.map(toField) } : {}) };
    };
    return { what, certificates, signers, digest, signatures, fields: [toField(root)], end: root.end, problems };
}

/** The certificates as rows. */
export function certificateRows(info: SignatureInfo): TableRow[] {
    return info.certificates.map((c) => ({
        group: c.usage.includes('timestamping') ? 'Timestamping' : c.usage.includes('code signing') ? 'Code signing' : c.authority ? 'Authorities' : 'Other',
        cells: { subject: nameText(c.subject, true), issuer: nameText(c.issuer), from: c.from.slice(0, 10), to: c.to.slice(0, 10), key: c.key, serial: c.serial },
    }));
}

/** Who signed it, in words: the signer and who vouches for them, for a summary. */
export function signedBy(info: SignatureInfo): string {
    const signer = info.signers[0];
    if (!signer) return info.certificates[0] ? nameText(info.certificates[0].subject) : 'no one';
    const cert = info.certificates.find((c) => c.serial === signer.serial);
    return cert ? `${nameText(cert.subject)}, vouched for by ${nameText(cert.issuer)}` : `someone ${nameText(signer.issuer)} vouched for`;
}

const parser: FormatParser = {
    parse(data) {
        let info: SignatureInfo;
        try {
            info = readSignature(data, 0, data.length);
        } catch (e) {
            throw new Error(`This isn’t a signature or a certificate: ${e instanceof Error ? e.message : String(e)}.`);
        }
        const signer = info.signers[0];
        const fields = [...info.fields];
        let end = info.end;
        // Authenticode pads its signature to 8 bytes with zeros (WIN_CERTIFICATE's length is a multiple of 8): saved as it's stored, they come along.
        if (end < data.length && data.length - end < 8 && data.subarray(end).every((v) => v === 0)) {
            fields.push(field('Padding', end, data.length - end, bytesLabel(data.length - end), 'Zeros, as Windows programs pad their signatures to 8 bytes.'));
            end = data.length;
        }
        const rows = certificateRows(info);
        return {
            title: info.what,
            summary: [
                ...(info.certificates.length && info.what === 'Certificate (X.509)'
                    ? [
                          ['Subject', nameText(info.certificates[0].subject, true)] as [string, string],
                          ['Issuer', nameText(info.certificates[0].issuer, true)] as [string, string],
                          ['Valid', `${info.certificates[0].from} to ${info.certificates[0].to}`] as [string, string],
                          ['Key', info.certificates[0].key] as [string, string],
                      ]
                    : [['Signed by', signedBy(info)] as [string, string]]),
                ...(signer?.program || signer?.url ? [['Program', [signer.program, signer.url].filter(Boolean).join(', ')] as [string, string]] : []),
                ...(info.digest ? [['Program’s hash', `${info.digest.algorithm}: ${info.digest.value}`] as [string, string]] : []),
                ...(signer?.signedAt ? [['Signed on', signer.signedAt] as [string, string]] : []),
                ...(signer?.timestamp ? [['Timestamped', `${signer.timestamp.at}${signer.timestamp.by ? `, by ${signer.timestamp.by}` : ''}`] as [string, string]] : []),
                ...(info.signatures > 1 ? [['Signatures', `${info.signatures}: the first, and ${info.signatures - 1} more inside it (with other hash algorithms)`] as [string, string]] : []),
                ['Certificates', String(info.certificates.length)],
                ['Checked', 'No: this says what the signature and certificates say, not whether they hold'],
            ],
            fields,
            entries:
                info.certificates.length > (info.what === 'Certificate (X.509)' ? 1 : 0)
                    ? info.certificates.map((c, i) => ({
                          name: null,
                          label: `Certificate ${i + 1} ${nameText(c.subject).replace(/[\\/:*?"<>|]/g, '_')}.cer`,
                          offset: c.tlv.at,
                          size: c.tlv.end - c.tlv.at,
                          data: data.subarray(c.tlv.at, c.tlv.end),
                          meta: { Issuer: nameText(c.issuer), Valid: `${c.from.slice(0, 10)} to ${c.to.slice(0, 10)}` },
                      }))
                    : undefined,
            preview: rows.length
                ? {
                      kind: 'table',
                      columns: [
                          { key: 'subject', label: 'Subject' },
                          { key: 'issuer', label: 'Issuer' },
                          { key: 'from', label: 'From' },
                          { key: 'to', label: 'To' },
                          { key: 'key', label: 'Key' },
                          { key: 'serial', label: 'Serial number' },
                      ],
                      groups: [...new Set(rows.map((r) => r.group))],
                      rows,
                  }
                : undefined,
            end,
            warnings: info.problems,
        };
    },
};

export default parser;
