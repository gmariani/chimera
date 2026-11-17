import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { REPO } from '../testing/game-data';
import { noticeOf, portedFiles, sectionsWithout } from './credits';
import { inline, Markdown } from './markdown';
import { PORTED_SOURCES } from './notices';

const sources = readFileSync(join(REPO, 'SOURCES.md'), 'utf8');

describe('credits', () => {
    it('take the notice of every file SOURCES.md lists as carrying code from elsewhere, and only those', () => {
        const files = portedFiles(sources)
            .map((p) => p.file)
            .filter((f) => f.endsWith('.ts'));
        expect(files.length).toBeGreaterThan(5);
        // notices.ts has to name the same files for the bundler; this catches one added to one list and not the other.
        expect(Object.keys(PORTED_SOURCES).sort()).toEqual([...files].sort());
        for (const f of files) {
            const notice = noticeOf(PORTED_SOURCES[f]);
            // A copyright line, or (ScummVM's) its developers named as the owners, and the terms.
            expect(notice, f).toMatch(/Copyright|legal property of its developers/);
            expect(notice, f).toMatch(/Permission|General Public License/);
            // Only the notice: not the reader's own words around it.
            expect(notice, f).not.toMatch(/Chimera takes it/);
        }
        // And the module's license note, for the folder.
        expect(portedFiles(sources).some((p) => p.file === 'wasm/bink/')).toBe(true);
    });

    it('take a notice from its indented block, blank lines and all', () => {
        const file = [
            '/**',
            ' * Ported from somewhere. Its notice:',
            ' *',
            ' *   Copyright (c) 2001 Someone',
            ' *',
            ' *   Permission is granted.',
            ' *',
            ' * Chimera takes it under the GPL.',
            ' */',
        ].join('\n');
        expect(noticeOf(file)).toBe('Copyright (c) 2001 Someone\n\nPermission is granted.');
        expect(noticeOf('/**\n * No notice here.\n */')).toBe('');
        const blast = noticeOf(readFileSync(join(REPO, 'src/core/explode.ts'), 'utf8'));
        expect(blast.split('\n')[0]).toBe('Copyright (C) 2003, 2012, 2013 Mark Adler');
        expect(blast.split('\n').at(-1)).toBe('Mark Adler    madler@alumni.caltech.edu');
    });

    it('read each row of the table, and leave out the sections asked', () => {
        const rows = portedFiles(sources);
        expect(rows[0]).toEqual(expect.objectContaining({ file: 'src/core/explode.ts', by: 'Mark Adler', license: 'zlib' }));
        const shown = sectionsWithout(sources, ['Adding to this list']);
        expect(shown).not.toMatch(/^# Sources/m);
        expect(shown).not.toMatch(/^## Adding to this list/m);
        expect(shown).toMatch(/^## Looked at, and not used/m);
    });

    it('render Markdown as elements, with links that stop before the punctuation after them', () => {
        const html = renderToStaticMarkup(<>{inline('See **this** and `code` at https://example.org/a_(b).')}</>);
        expect(html).toBe('See <strong>this</strong> and <code>code</code> at <a href="https://example.org/a_(b" target="_blank" rel="noreferrer">https://example.org/a_(b</a>).');
        const doc = renderToStaticMarkup(<Markdown text={'## Head\n\nA line\nwrapped.\n\n- one\n- two\n\n| A | B |\n| --- | --- |\n| 1 | <b> |'} />);
        expect(doc).toBe(
            '<h3>Head</h3><p>A line wrapped.</p><ul><li>one</li><li>two</li></ul><div class="table-responsive"><table class="table table-sm small"><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>&lt;b&gt;</td></tr></tbody></table></div>'
        );
    });
});
