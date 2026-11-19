import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Parsed } from '../core/types';
import { gameDir, gameFile } from '../testing/game-data';
import { authenticode, certificate } from '../testing/samples';
import { detect } from './index';
import { inspect } from './inspect';
import pe from './pe';
import pkcs7 from './pkcs7';

const parse = (data: Uint8Array) => pkcs7.parse(data, { name: 'signature.p7s', names: [] }) as Parsed;
const summary = (r: Parsed) => Object.fromEntries(r.summary);

describe('signatures and certificates (PKCS #7, X.509)', () => {
    it('reads an Authenticode signature: who signed, the program’s hash, when, every byte marked', async () => {
        const data = authenticode();
        expect(detect(data, 'signature.p7s').id).toBe('pkcs7');
        expect(detect(data, null).id).toBe('pkcs7');
        const inspected = await inspect(data, { name: 'signature.p7s', names: [] });
        expect(inspected.checks).toEqual([]);
        const r = inspected.parsed;
        expect(r.warnings).toEqual([]);
        expect(r.title).toBe('Authenticode signature');
        expect(summary(r)).toMatchObject({
            'Signed by': 'Chimera Sample, vouched for by Chimera Test CA',
            Program: 'Chimera Sample',
            'Program’s hash': `SHA-256: ${'AB'.repeat(32)}`,
            'Signed on': '2021-06-15 12:00:00 UTC',
            Certificates: '1',
        });
        expect(r.fields.reduce((n, f) => n + f.length, 0)).toBe(data.length);
        expect(r.fields.at(-1)?.name).toBe('Padding');
        // The certificate, to open on its own.
        expect(r.entries!.map((e) => e.label)).toEqual(['Certificate 1 Chimera Sample.cer']);
        expect([...r.entries![0].data]).toEqual(certificate());
    });

    it('reads a certificate on its own', async () => {
        const data = Uint8Array.from(certificate());
        expect(detect(data, 'certificate.cer').id).toBe('x509');
        const inspected = await inspect(data, { name: 'certificate.cer', names: [] });
        expect(inspected.checks).toEqual([]);
        expect(summary(inspected.parsed)).toMatchObject({
            Subject: 'Chimera Sample (Chimera, US)',
            Issuer: 'Chimera Test CA',
            Valid: '2020-01-01 00:00:00 UTC to 2030-12-31 23:59:59 UTC',
            Key: 'RSA, 1024 bits',
        });
        const p = inspected.parsed.preview!;
        expect(p.kind === 'table' && p.rows).toEqual([{ group: 'Code signing', cells: expect.objectContaining({ serial: '1234', from: '2020-01-01', to: '2030-12-31' }) }]);
    });

    it('says what doesn’t fit, and refuses what isn’t one', () => {
        // The signer's certificate missing: its serial number changed.
        const data = authenticode();
        const serial = [...data].findLastIndex((v, i) => v === 0x12 && data[i + 1] === 0x34);
        data[serial] = 0x56;
        expect(parse(data).warnings).toEqual(['The certificate of the signer Chimera Test CA vouched for (serial 5634) isn’t in it: what signed it can’t be told from it.']);
        // A length that runs past the end; an indefinite length (BER, not DER).
        const cut = authenticode().subarray(0, 300);
        expect(() => parse(cut)).toThrow(/^This isn’t a signature or a certificate: the value at 0 says it’s \d[\d,]* bytes, past what holds it\.$/);
        const indefinite = authenticode();
        indefinite[1] = 0x80;
        expect(() => parse(indefinite)).toThrow('This isn’t a signature or a certificate: the value at 0 has an indefinite length, which DER doesn’t allow.');
    });
});

// Ground truth from outside: what OpenSSL makes, and says, when it's installed.
const openssl = spawnSync('openssl', ['version']).status === 0;
describe.skipIf(!openssl)('what OpenSSL makes', () => {
    it('reads its certificate and its signature as OpenSSL does', () => {
        const dir = mkdtempSync(join(tmpdir(), 'chimera-openssl-'));
        const run = (...args: string[]) => {
            const r = spawnSync('openssl', args, { cwd: dir, encoding: 'utf-8' });
            if (r.status !== 0) throw new Error(r.stderr);
            return r.stdout;
        };
        try {
            run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'key.pem', '-out', 'cert.pem', '-days', '30', '-subj', '/C=US/O=Chimera Test/CN=Chimera OpenSSL', '-set_serial', '4660');
            run('x509', '-in', 'cert.pem', '-outform', 'DER', '-out', 'cert.der');
            writeFileSync(join(dir, 'data.txt'), 'hello');
            run('cms', '-sign', '-in', 'data.txt', '-signer', 'cert.pem', '-inkey', 'key.pem', '-outform', 'DER', '-out', 'sig.p7s', '-binary');
            const said = run('x509', '-in', 'cert.pem', '-noout', '-startdate', '-enddate');
            const date = (line: string) => new Date(said.match(new RegExp(`${line}=(.*)`))![1]).toISOString().replace('T', ' ').replace('.000Z', ' UTC');

            const cert = parse(new Uint8Array(readFileSync(join(dir, 'cert.der'))));
            expect(cert.warnings).toEqual([]);
            expect(summary(cert)).toMatchObject({
                Subject: 'Chimera OpenSSL (Chimera Test, US)',
                Issuer: 'Chimera OpenSSL (Chimera Test, US)',
                Valid: `${date('notBefore')} to ${date('notAfter')}`,
                Key: 'RSA, 2048 bits',
            });
            const sig = new Uint8Array(readFileSync(join(dir, 'sig.p7s')));
            expect(detect(sig, 'sig.p7s').id).toBe('pkcs7');
            const r = parse(sig);
            expect(r.warnings).toEqual([]);
            expect(r.title).toBe('Signed data (PKCS #7)');
            expect(summary(r)['Signed by']).toBe('Chimera OpenSSL, vouched for by Chimera OpenSSL');
            expect(r.fields.reduce((n, f) => n + f.length, 0)).toBe(sig.length);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

const game = gameFile('tiberianSun', 'Game.exe');
describe.skipIf(!game)('Tiberian Sun’s Game.exe', () => {
    it('is signed by Electronic Arts, vouched for by DigiCert, and timestamped', () => {
        const r = pe.parse(new Uint8Array(readFileSync(game!)), { name: 'Game.exe', names: [] }) as Parsed;
        expect(summary(r).Signed).toBe(
            'Electronic Arts, Inc., vouched for by DigiCert Trusted G4 Code Signing RSA4096 SHA384 2021 CA1; the program’s SHA-256 hash; timestamped 2024-03-08 (Authenticode), not checked here'
        );
        const sig = parse(r.entries!.find((e) => e.name === 'Game-signature-1.p7s')!.data);
        expect(summary(sig)).toMatchObject({
            'Program’s hash': 'SHA-256: FB68FFCA298A8DF1852E0002E13EDD35A15DB8C2EF4CB5DB496D7E1B78FBD36F',
            Timestamped: '2024-03-08 22:32:16 UTC, by DigiCert Timestamp 2023',
            Certificates: '5',
        });
    });
});

const CNC = gameDir('cncRemastered');
describe.skipIf(!CNC)('the first Authenticode signatures', () => {
    it('reads Acrobat Reader 3’s installer’s, from 1996: the signed data alone', () => {
        const r = pe.parse(new Uint8Array(readFileSync(join(CNC!, 'RED_ALERT/COUNTERSTRIKE/INTERNET/TA/ACROREAD.EXE'))), { name: 'ACROREAD.EXE', names: [] }) as Parsed;
        expect(r.warnings).toEqual([]);
        const sig = parse(r.entries!.find((e) => e.name === 'ACROREAD-signature-1.p7s')!.data);
        expect(sig.title).toBe('Authenticode signature (the first kind, 1996–97)');
        expect(summary(sig)).toMatchObject({
            'Signed by': 'Adobe Systems Incorporated, vouched for by VeriSign, Inc.',
            Program: 'Acrobat Reader 3.0, http://www.adobe.com',
            'Program’s hash': 'MD5: 41B837F3809C3B44657C3821C56C2ACC',
        });
    });
});
