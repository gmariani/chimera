import { TooBig } from '../core/limits';
import { bytesLabel } from '../core/bytes';
import type { Entry, FormatDescriptor, ParseContext, Parsed } from '../core/types';
import { entropy, namedAs, signature, type Signature } from './identify';
import { FORMATS, RAW, extension, extensionOf } from './index';
import { sniffText } from './westwood/sniff';

/**
 * Opening a file, with the checks that apply to every format: does it hold
 * up as what its name and first bytes say it is, is anything hidden after
 * its end, and, when nothing reads it, what it really is. Parsers report
 * what's wrong inside their own format (as warnings, or by throwing when the
 * file isn't one at all); this catches the rest, so a file only dressed up as
 * a format (a ".gif" that's "GIF" and then base64) is called out.
 */

export interface Check {
    /** danger: it isn't what it claims, or hides something. warning: worth a look. info: just so you know. */
    level: 'danger' | 'warning' | 'info';
    text: string;
}

export interface Inspection {
    format: FormatDescriptor;
    parsed: Parsed;
    checks: Check[];
    /** Other formats it could be opened as: those its content or name point to. */
    alternatives: FormatDescriptor[];
}

const RANDOM = 7.5;
/** Extensions that say a file is a copy, not what it is. */
const BACKUPS = ['bak', 'old', 'orig', 'tmp', 'sav'];

function sniffs(format: FormatDescriptor, data: Uint8Array): boolean {
    try {
        return format.sniff(data);
    } catch {
        return false;
    }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** A parser asking for more memory than the app allows, or than there is (an unchecked size from the file). */
const exhausting = (e: unknown) => e instanceof TooBig || (e instanceof RangeError && /array length|allocation failed|string length/i.test(e.message));
const unique = <T>(list: T[]) => [...new Set(list)];

/** True when a format here reads these bytes: by its signature, not just because it's text. */
function recognized(data: Uint8Array): FormatDescriptor | null {
    return FORMATS.find((f) => f.id !== 'text' && f.id !== 'ini' && sniffs(f, data)) ?? null;
}

/** What some bytes are, in a few words, and the extension to save them under. */
export function describe(data: Uint8Array): { what: string; ext: string; signature: Signature | null } {
    const sig = signature(data);
    if (sig && !sig.format) return { what: sig.name, ext: sig.ext, signature: sig };
    const format = recognized(data);
    if (format) return { what: format.name, ext: extensionOf(format), signature: sig };
    if (sig) return { what: sig.name, ext: sig.ext, signature: sig };
    if (sniffText(data)) return { what: 'text', ext: 'txt', signature: null };
    const bits = entropy(data);
    return { what: bits > RANDOM ? 'random-looking bytes (compressed or encrypted)' : 'data no format here recognizes', ext: 'bin', signature: null };
}

/** The first bytes as text a person can read, e.g. “GIF”. */
function quoted(data: Uint8Array, length: number): string {
    const text = Array.from(data.subarray(0, Math.min(length, 16)), (c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '·')).join('');
    return `“${text}”`;
}

/** “a” or “an”, for a format's name. */
const a = (name: string) => (/^[aeiou]/i.test(name) ? `an ${name}` : `a ${name}`);

/** Sniffed formats, those the name points to first, then formats named alone. `fits` also has the formats that go by the name without it suggesting them. */
function candidates(data: Uint8Array, ext: string | null): { sniffed: FormatDescriptor[]; named: FormatDescriptor[]; fits: FormatDescriptor[]; order: FormatDescriptor[] } {
    const sniffed = FORMATS.filter((f) => sniffs(f, data));
    const named = ext ? FORMATS.filter((f) => f.extensions.includes(ext)) : [];
    const fits = ext ? FORMATS.filter((f) => f.extensions.includes(ext) || f.alsoNamed?.includes(ext)) : [];
    const order = unique([...sniffed.filter((f) => named.includes(f)), ...sniffed, ...named.filter((f) => f.byNameAlone !== false)]);
    return { sniffed, named, fits, order };
}

/**
 * Opens the data as its format (or as `as`, a format id), and checks it is
 * one. `shownName` is the name the file goes by when the context has no real
 * one (a label from an archive).
 */
export async function inspect(data: Uint8Array, context: ParseContext, { as, shownName }: { as?: string; shownName?: string } = {}): Promise<Inspection> {
    const ext = extension(context.name ?? shownName ?? null);
    const { sniffed, named, fits, order: found } = candidates(data, ext);
    const forced = as ? (FORMATS.find((f) => f.id === as) ?? null) : null;
    const order = forced ? [forced] : found;
    const sig = signature(data);
    const signed = sig?.format ? (FORMATS.find((f) => f.id === sig.format) ?? null) : null;

    const failures = new Map<FormatDescriptor, string>();
    /** Formats whose parser was stopped from allocating what the file asked for. */
    const stopped = new Map<FormatDescriptor, string>();
    const tryParse = async (format: FormatDescriptor): Promise<Parsed | null> => {
        try {
            return (await format.load()).parse(data, context);
        } catch (e) {
            failures.set(format, message(e));
            if (exhausting(e)) stopped.set(format, message(e));
            return null;
        }
    };

    let format: FormatDescriptor = RAW;
    let parsed: Parsed | null = null;
    for (const f of order) {
        parsed = await tryParse(f);
        if (parsed) {
            format = f;
            break;
        }
    }

    // What the name and signature claim, and what reading it as that says.
    const textual = sniffText(data);
    const claimed = named.filter((f) => f.byNameAlone !== false);
    const nameHolds = !ext || !claimed.length || fits.includes(format) || (textual && claimed.some((f) => f.id === 'text'));
    const signatureHolds = !signed || signed === format;
    const readsAlso: FormatDescriptor[] = [];
    if (!forced) {
        for (const f of unique([...(nameHolds ? [] : claimed), ...(signatureHolds || !signed ? [] : [signed])])) {
            if (failures.has(f) || f === format) continue;
            if (await tryParse(f)) readsAlso.push(f);
        }
    }

    const checks: Check[] = [];
    let title: string | null = null;
    // A size no real file has: the mark of one made to crash or exhaust a parser.
    for (const [f, why] of stopped)
        checks.push({ level: 'danger', text: `Reading it as ${f.name} was stopped before it could run out of memory: ${why} Files made to break parsers ask for sizes like this.` });
    const extraFields: Parsed['fields'] = [];
    const extraEntries: Entry[] = [];
    const extraSummary: [string, string][] = [];

    // Nothing could read it.
    if (!parsed) {
        parsed = (await RAW.load()).parse(data, context);
        if (forced) checks.push({ level: 'danger', text: `It can't be read as ${forced.name}: ${failures.get(forced)}` });
    }

    const what = (() => {
        if (format !== RAW) return format.name;
        if (sig && !sig.format) return a(sig.name);
        return data.length ? 'data no format here recognizes' : 'an empty file';
    })();

    // The claims, together when the name and signature say the same thing.
    const reason = (f: FormatDescriptor) => (failures.has(f) ? ` Read as ${f.name}: ${failures.get(f)}` : '');
    const claimNames = (fs: FormatDescriptor[]) => unique(fs.map((f) => f.name)).join(' or ');
    const holds = (f: FormatDescriptor) => readsAlso.includes(f);
    if (!forced) {
        // Read as what its name says, it holds up: that's enough.
        // (A module with no code under another name, as Dune II's DUNE2.ICO is, gets its own warning below instead: it can't run.)
        const codelessModule = !!sig?.codeless && format.id === sig.format;
        const nameClaims = nameHolds || claimed.some(holds) || codelessModule ? [] : claimed;
        const sigClaim = signatureHolds || !signed || holds(signed) ? null : signed;
        if (sigClaim && nameClaims.includes(sigClaim)) {
            checks.push({ level: 'danger', text: `It's named .${ext} and starts like ${a(sig!.name)} (${quoted(data, sig!.length)}), but it isn't one: this is ${what}.${reason(sigClaim)}` });
        } else {
            if (nameClaims.length) checks.push({ level: 'danger', text: `It's named .${ext}, but it isn't ${claimNames(nameClaims)}: this is ${what}.${nameClaims.map(reason).join('')}` });
            if (sigClaim) checks.push({ level: 'danger', text: `It starts like ${a(sig!.name)} (${quoted(data, sig!.length)}), but it isn't one: this is ${what}.${reason(sigClaim)}` });
        }
        // A program or script under another type's name (a backup's name says nothing either way).
        // (Read by nothing, or by the reader for programs of its kind: a 16-bit Windows module read as one is still a program.)
        const asProgram = format === RAW || format.id === sig?.format;
        if (asProgram && sig?.runs && ext && !namedAs(sig, ext) && nameHolds) {
            checks.push({ level: BACKUPS.includes(ext) ? 'warning' : 'danger', text: `It's ${a(sig.name)}, named .${ext}.` });
        }
        // A program's container with no code, under another name: it can't run, but it isn't what the name says (Dune II's DUNE2.ICO).
        if (asProgram && sig?.codeless && ext && !namedAs(sig, ext) && !BACKUPS.includes(ext)) {
            checks.push({ level: 'warning', text: `It's named .${ext}, but it's ${a(sig.name)}: laid out like a program, but with nothing in it to run.` });
        }
        for (const f of readsAlso)
            checks.push({ level: 'info', text: `It also reads as ${f.name}, as its ${f === signed ? 'first bytes suggest' : 'name suggests'}; use Open as to see it that way.` });
        // A document or page that's text underneath, shown as text.
        if (format.id === 'text' && sig && !sig.format) {
            title = sig.name;
            extraSummary.push(['Signature', `${sig.name}, ${quoted(data, sig.length)}`]);
            if (!namedAs(sig, ext)) checks.push({ level: sig.runs ? 'warning' : 'info', text: `This is ${a(sig.name)}; there's no parser for it here, so it's shown as text.` });
        }
    }

    // Nothing read it, though something looked like it might.
    if (format === RAW && !forced && !sig) {
        for (const f of sniffed) {
            if (claimed.includes(f) || !failures.has(f)) continue;
            checks.push({ level: 'info', text: `It looked like ${f.name}, but couldn't be read as one: ${failures.get(f)}` });
        }
    }

    // What nothing could read really is.
    if (format === RAW && data.length) {
        if (sig) {
            title = sig.name;
            extraSummary.push(['Signature', `${sig.name}, ${quoted(data, sig.length)}`]);
            // Unless it's already been said, as a program under another name.
            if (!sig.format && !((sig.runs || sig.codeless) && ext && !namedAs(sig, ext)))
                checks.push({ level: sig.runs && !ext ? 'warning' : 'info', text: `This is ${a(sig.name)}; there's no parser for it here, so it's shown as bytes.` });
        }
        const bits = entropy(data);
        if (!sig && bits > RANDOM) checks.push({ level: 'info', text: `The bytes look random (${bits.toFixed(2)} bits per byte, of 8): compressed or encrypted.` });
    }
    // How varied the bytes are, for anything no format explains: plain text is around 4–5 bits per byte, encoded data higher, compressed or encrypted data near 8.
    if ((format === RAW || format.id === 'text') && data.length) extraSummary.push(['Entropy', `${entropy(data).toFixed(2)} bits per byte`]);

    // Anything after the format's own end.
    if (format !== RAW && format.id !== 'text' && parsed.fields.length) {
        // The parser may have marked what's after its end itself; then it needs no field from here.
        const marked = parsed.end !== undefined;
        let end = parsed.end ?? 0;
        if (!marked) for (const f of parsed.fields) end = Math.max(end, f.offset + f.length);
        if (end < data.length) {
            const tail = data.subarray(end);
            const zeros = tail.every((b) => b === 0);
            if (zeros && tail.length < 16) {
                if (!marked) extraFields.push({ name: 'Padding', offset: end, length: tail.length, value: bytesLabel(tail.length), note: 'Zeros after the end, to round the file up.' });
            } else if (zeros) {
                if (!marked) extraFields.push({ name: 'After the end', offset: end, length: tail.length, value: `${bytesLabel(tail.length)} of zeros` });
                checks.push({ level: 'info', text: `There are ${bytesLabel(tail.length)} of zeros after the end of the ${format.name.toLowerCase()}.` });
            } else {
                const inner = describe(tail);
                if (!marked)
                    extraFields.push({
                        name: 'After the end',
                        offset: end,
                        length: tail.length,
                        value: `${bytesLabel(tail.length)}: ${inner.what}`,
                        note: `Not part of the ${format.name.toLowerCase()}. Under Contents.`,
                    });
                extraEntries.push({ name: null, label: `after the end.${inner.ext}`, offset: end, size: tail.length, data: tail });
                checks.push({
                    level: 'danger',
                    text: `There are ${bytesLabel(tail.length)} after the end of the ${format.name.toLowerCase()} (at offset ${end}): ${inner.what}. Hiding data after a file's end is a common way to smuggle it; it's under Contents.`,
                });
            }
        }
    }

    const alternatives = unique([...sniffed, ...named, ...(signed ? [signed] : [])]).filter((f) => f !== format);
    // Text or bytes shown as one field: what was found inside goes under it.
    const [only] = parsed.fields;
    const whole = parsed.fields.length === 1 && only.offset === 0 && only.length === data.length && !only.children;
    const fields = whole && extraFields.length ? [{ ...only, children: extraFields }] : [...parsed.fields, ...extraFields];
    const result: Parsed = {
        ...parsed,
        title: title ?? parsed.title,
        summary: [...parsed.summary, ...extraSummary],
        fields,
        entries: parsed.entries || extraEntries.length ? [...(parsed.entries ?? []), ...extraEntries] : undefined,
    };
    // The levels in order, so the worst is read first.
    const rank = { danger: 0, warning: 1, info: 2 };
    checks.sort((x, y) => rank[x.level] - rank[y.level]);
    return { format, parsed: result, checks, alternatives };
}
