import type { ReactNode } from 'react';

/**
 * The little Markdown the repository's own documents use (SOURCES.md, shown under Credits): headings, paragraphs,
 * lists, tables, **bold**, `code` and bare links. It builds elements, never HTML from the text, so nothing in a
 * document can run. A document's sections (##) are headings of `level`, its subsections one below; its title (#)
 * is left to the page around it.
 */

/** Text with **bold**, `code` and bare http(s) links made into elements. */
export function inline(text: string): ReactNode[] {
    const out: ReactNode[] = [];
    const pattern = /\*\*(.+?)\*\*|`([^`]+)`|(https?:\/\/[^\s)]+[^\s).,;:])/g;
    let last = 0;
    for (const m of text.matchAll(pattern)) {
        if (m.index > last) out.push(text.slice(last, m.index));
        const key = out.length;
        if (m[1] !== undefined) out.push(<strong key={key}>{inline(m[1])}</strong>);
        else if (m[2] !== undefined) out.push(<code key={key}>{m[2]}</code>);
        else
            out.push(
                <a key={key} href={m[3]} target='_blank' rel='noreferrer'>
                    {m[3]}
                </a>
            );
        last = m.index + m[0].length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
}

const cells = (row: string) =>
    row
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((c) => c.trim());

export function Markdown({ text, level = 3 }: { text: string; level?: number }) {
    const blocks: ReactNode[] = [];
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    for (let i = 0; i < lines.length;) {
        const line = lines[i];
        const heading = /^(#{1,6}) (.*)$/.exec(line);
        if (!line.trim()) {
            i++;
        } else if (heading) {
            const Tag = `h${Math.min(6, Math.max(1, level + heading[1].length - 2))}` as 'h3';
            blocks.push(<Tag key={i}>{inline(heading[2])}</Tag>);
            i++;
        } else if (line.startsWith('|')) {
            const rows: string[][] = [];
            for (; i < lines.length && lines[i].startsWith('|'); i++) if (!/^\|[\s|:-]+\|$/.test(lines[i])) rows.push(cells(lines[i]));
            const [head, ...body] = rows;
            blocks.push(
                <div key={i} className='table-responsive'>
                    <table className='table table-sm small'>
                        <thead>
                            <tr>
                                {head.map((c, k) => (
                                    <th key={k}>{inline(c)}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {body.map((r, k) => (
                                <tr key={k}>
                                    {r.map((c, n) => (
                                        <td key={n}>{inline(c)}</td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            );
        } else if (line.startsWith('- ')) {
            const items: string[] = [];
            for (; i < lines.length && lines[i].startsWith('- '); i++) items.push(lines[i].slice(2));
            blocks.push(
                <ul key={i}>
                    {items.map((item, k) => (
                        <li key={k}>{inline(item)}</li>
                    ))}
                </ul>
            );
        } else {
            const para: string[] = [];
            for (; i < lines.length && lines[i].trim() && !/^(#{1,6} |\||- )/.test(lines[i]); i++) para.push(lines[i]);
            blocks.push(<p key={i}>{inline(para.join(' '))}</p>);
        }
    }
    return <>{blocks}</>;
}
