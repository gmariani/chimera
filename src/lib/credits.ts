/**
 * What the Credits list reads from the repository's own files, so nothing it shows is written twice: which files
 * carry code from other projects (the first table in SOURCES.md), and each one's notice, as the file keeps it in its
 * opening comment, indented under the line that introduces it.
 */

export interface Ported {
    /** The file in Chimera, from the repository's root ("src/core/explode.ts"), or a folder ("wasm/bink/"). */
    file: string;
    from: string;
    by: string;
    license: string;
    changed: string;
}

/** The rows of the first table in SOURCES.md ("Code from other projects"), in its order. */
export function portedFiles(sources: string): Ported[] {
    const section = sources.split(/^## /m).find((s) => s.startsWith('Code from other projects'));
    if (!section) return [];
    return section
        .split('\n')
        .filter((line) => line.startsWith('| `'))
        .map((line) => {
            const [file, from, by, license, changed] = line
                .replace(/^\||\|$/g, '')
                .split('|')
                .map((c) => c.trim());
            return { file: file.replace(/`/g, '').replace(/ \(.*\)$/, ''), from, by, license, changed };
        });
}

/** A Markdown document without its title, nor the sections named (by their heading). */
export function sectionsWithout(text: string, omit: string[]): string {
    return text
        .replace(/^# .*\n/, '')
        .split(/^(?=## )/m)
        .filter((s) => !omit.some((o) => s.startsWith(`## ${o}`)))
        .join('');
}

/**
 * The notice in a file's opening comment: the lines indented past the comment's own " * " after the line that
 * introduces it (one that speaks of the notice and ends in a colon: "That file's notice:"), with the blank comment
 * lines between them, taken out of the comment. Empty when the file has none.
 */
export function noticeOf(source: string): string {
    const comment = /\/\*\*\n([\s\S]*?)\n \*\//.exec(source)?.[1];
    if (!comment) return '';
    const lines = comment.split('\n').map((l) => l.replace(/^ \*( |$)/, ''));
    // The sentence that introduces it may wrap: from the line that speaks of the notice to the one ending in a colon.
    const speaks = lines.findIndex((l) => /\bnotice\b/i.test(l));
    const intro = speaks < 0 ? -1 : lines.findIndex((l, i) => i >= speaks && /:$/.test(l));
    if (intro < 0) return '';
    const indented = lines.map((l, i) => i > intro && /^ {2}/.test(l));
    const first = indented.indexOf(true);
    const last = indented.lastIndexOf(true);
    if (first < 0) return '';
    // A blank line inside the notice belongs to it; one that leads back to unindented text ends it.
    let end = first;
    for (let i = first; i <= last; i++) {
        if (indented[i]) end = i;
        else if (lines[i].trim()) break;
    }
    return lines
        .slice(first, end + 1)
        .map((l) => l.replace(/^ {2}/, ''))
        .join('\n');
}
