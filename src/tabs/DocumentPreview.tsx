import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { Button, ButtonGroup, Form } from 'react-bootstrap';
import type { DocumentBlock, DocumentLink, DocumentParagraph, DocumentPicture, DocumentPreview as DocumentData, DocumentRun, DocumentStyle } from '../core/types';
import { Muted } from '../components/ui';

/** Fonts old programs asked Windows for, and ones a browser is likely to have that look like them. */
const SUBSTITUTES: Record<string, string> = {
    helv: 'Arial, Helvetica',
    helvetica: 'Helvetica, Arial',
    'ms sans serif': "'Microsoft Sans Serif', Tahoma, Arial",
    'tms rmn': "'Times New Roman', Times",
    'ms serif': "'Times New Roman', Times",
    times: "'Times New Roman', Times",
    courier: "'Courier New', Courier",
    system: 'Tahoma, Arial',
};

/** Tab stops where a paragraph sets none: every half inch, in points. */
const DEFAULT_TAB = 36;
/** Tabs in a paragraph laid out to their stops; any more get a stop's width. */
const MOST_TABS = 200;

function css(style: DocumentStyle | undefined): CSSProperties {
    if (!style) return {};
    const face = style.face?.trim();
    const family = [face && `'${face.replace(/'/g, '')}'`, face && SUBSTITUTES[face.toLowerCase()], style.family ?? 'sans-serif'].filter(Boolean).join(', ');
    return {
        fontFamily: family,
        fontSize: style.size ? `${style.size}pt` : undefined,
        fontWeight: style.bold ? 700 : 400,
        fontStyle: style.italic ? 'italic' : 'normal',
        textDecorationLine: [style.underline && 'underline', style.strike && 'line-through'].filter(Boolean).join(' ') || 'none',
        textDecorationStyle: style.underline === 'dotted' ? 'dotted' : style.underline === 'double' ? 'double' : undefined,
        color: style.color,
    };
}

type Go = (link: DocumentLink, at: { x: number; y: number }) => void;

/** Where a popup opens: under the hotspot that opened it. */
const below = (el: Element) => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.bottom };
};

/**
 * Formatted pages as the program that showed them laid them out, in a window of their own: a help file's topics, with
 * the non-scrolling band at the top, hotspots that lead where they do (popups open over the page), Back, Contents and
 * the browse buttons, and a list to pick a page from.
 */
export function DocumentPreview({ preview }: { preview: DocumentData }) {
    const [page, setPage] = useState(preview.start);
    const [back, setBack] = useState<number[]>([]);
    const [popup, setPopup] = useState<{ page: number; x: number; y: number } | null>(null);
    const frame = useRef<HTMLDivElement>(null);
    const scroller = useRef<HTMLDivElement>(null);
    const popupBox = useRef<HTMLDivElement>(null);
    // Another file's pages start over.
    const [shown, setShown] = useState(preview);
    if (shown !== preview) {
        setShown(preview);
        setPage(preview.start);
        setBack([]);
        setPopup(null);
    }
    // A popup closes at a click anywhere else, or Escape.
    useEffect(() => {
        if (!popup) return;
        const click = (e: Event) => {
            if (!(e.target instanceof Node && popupBox.current?.contains(e.target))) setPopup(null);
        };
        const key = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setPopup(null);
        };
        document.addEventListener('mousedown', click);
        document.addEventListener('keydown', key);
        return () => {
            document.removeEventListener('mousedown', click);
            document.removeEventListener('keydown', key);
        };
    }, [popup]);

    const open = (to: number) => {
        if (to === page) return;
        setBack((b) => [...b, page].slice(-200));
        setPage(to);
        setPopup(null);
    };
    useEffect(() => {
        scroller.current?.scrollTo(0, 0);
    }, [page]);

    const go: Go = (link, at) => {
        if (link.page === undefined) return;
        if (!link.popup) return open(link.page);
        const box = frame.current?.getBoundingClientRect();
        setPopup({ page: link.page, x: at.x - (box?.left ?? 0), y: at.y - (box?.top ?? 0) });
    };
    const current = preview.pages[page];
    if (!current) return <Muted>It has no pages.</Muted>;

    return (
        <div className='cell-row cell-row--boxed'>
            <div className='cell cell--stage'>
                <div className='doc-stage'>
                    <div className='doc-window' ref={frame}>
                        <div className='doc-caption'>{preview.title}</div>
                        <div className='doc-buttons'>
                            <ButtonGroup size='sm'>
                                <Button variant='outline-dark' onClick={() => open(preview.start)} disabled={page === preview.start}>
                                    Contents
                                </Button>
                                <Button
                                    variant='outline-dark'
                                    disabled={!back.length}
                                    onClick={() => {
                                        setPage(back[back.length - 1]);
                                        setBack(back.slice(0, -1));
                                        setPopup(null);
                                    }}>
                                    Back
                                </Button>
                                <Button variant='outline-dark' disabled={page === 0} onClick={() => open(page - 1)} aria-label='Previous topic'>
                                    &lt;&lt;
                                </Button>
                                <Button variant='outline-dark' disabled={page === preview.pages.length - 1} onClick={() => open(page + 1)} aria-label='Next topic'>
                                    &gt;&gt;
                                </Button>
                            </ButtonGroup>
                        </div>
                        {current.fixed.length > 0 && (
                            <div className='doc-fixed' style={{ background: current.fixedBackground }}>
                                <Blocks blocks={current.fixed} preview={preview} go={go} />
                            </div>
                        )}
                        <div className='doc-body' ref={scroller} style={{ background: current.background }}>
                            <Blocks blocks={current.body} preview={preview} go={go} />
                        </div>
                        {popup && preview.pages[popup.page] && (
                            <div className='doc-popup' style={{ left: `min(${Math.max(8, popup.x)}px, 25%)`, top: Math.max(8, popup.y + 4) }} ref={popupBox}>
                                <Blocks blocks={[...preview.pages[popup.page].fixed, ...preview.pages[popup.page].body]} preview={preview} go={go} />
                            </div>
                        )}
                    </div>
                </div>
            </div>
            <div className='cell cell--side'>
                <Form.Select size='sm' className='mb-3' value={page} onChange={(e) => open(Number(e.target.value))} aria-label='Topic'>
                    {preview.pages.map((p, i) => (
                        <option key={i} value={i}>
                            {p.title}
                        </option>
                    ))}
                </Form.Select>
                <p className='small text-body-secondary mb-2'>
                    Page {(page + 1).toLocaleString('en-US')} of {preview.pages.length.toLocaleString('en-US')}. Green text and pictures lead somewhere: underlined, to another topic; dotted, to a
                    popup over this one. Pointing at one says where.
                </p>
                {preview.note && <p className='small text-body-secondary mb-0'>{preview.note}</p>}
            </div>
        </div>
    );
}

function Blocks({ blocks, preview, go }: { blocks: DocumentBlock[]; preview: DocumentData; go: Go }) {
    return <>{blocks.map((b, i) => (b.kind === 'table' ? <Table key={i} table={b} preview={preview} go={go} /> : <Paragraph key={i} paragraph={b} preview={preview} go={go} />))}</>;
}

function Table({ table, preview, go }: { table: Extract<DocumentBlock, { kind: 'table' }>; preview: DocumentData; go: Go }) {
    const total = table.columns.reduce((n, c) => n + Math.max(0, c.width) + Math.max(0, c.gap), 0) || 1;
    const size = (v: number) => (table.relative ? `${(Math.max(0, v) / total) * 100}%` : `${Math.max(0, v)}pt`);
    const columns = table.columns.length || Math.max(1, ...table.rows.map((r) => r.length));
    return (
        <table className='doc-table' style={{ marginLeft: table.columns[0] ? size(table.columns[0].gap) : undefined, width: table.relative ? '100%' : undefined }}>
            <colgroup>
                {Array.from({ length: columns }, (_, i) => (
                    <col key={i} style={{ width: table.columns[i] ? size(table.columns[i].width + (table.columns[i + 1]?.gap ?? 0)) : undefined }} />
                ))}
            </colgroup>
            <tbody>
                {table.rows.map((row, r) => (
                    <tr key={r}>
                        {Array.from({ length: columns }, (_, c) => (
                            <td key={c} style={{ paddingRight: table.columns[c + 1] ? size(table.columns[c + 1].gap) : 0 }}>
                                {(row[c] ?? []).map((p, i) => (
                                    <Paragraph key={i} paragraph={p} preview={preview} go={go} />
                                ))}
                            </td>
                        ))}
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

function Paragraph({ paragraph: p, preview, go }: { paragraph: DocumentParagraph; preview: DocumentData; go: Go }) {
    const ref = useRef<HTMLDivElement>(null);
    const hasTabs = p.runs.some((r) => r.kind === 'tab');
    // Tabs: each one stretches to the next stop past where it starts, measured from the paragraph's left edge.
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el || !hasTabs) return;
        const px = 96 / 72;
        const stops = (p.tabs ?? []).map((t) => t.at * px).sort((a, b) => a - b);
        // A hanging first line stops at the indent too.
        if ((p.indentFirst ?? 0) < 0 && p.indentLeft) stops.push(p.indentLeft * px);
        stops.sort((a, b) => a - b);
        const left = el.getBoundingClientRect().left;
        // Each one measured lays the page out again: past the first few hundred (no real paragraph has so many), a fixed width.
        for (const [i, tab] of [...el.querySelectorAll<HTMLElement>(':scope > .doc-tab')].entries()) {
            if (i >= MOST_TABS) {
                tab.style.width = `${DEFAULT_TAB * px}px`;
                continue;
            }
            tab.style.width = '0px';
            const x = tab.getBoundingClientRect().left - left;
            const stop = stops.find((s) => s > x + 1) ?? (Math.floor(x / (DEFAULT_TAB * px)) + 1) * DEFAULT_TAB * px;
            tab.style.width = `${stop - x}px`;
        }
    });
    const b = p.border;
    const line = b ? `${b.double ? 3 : b.thick ? 2 : 1}px ${b.double ? 'double' : 'solid'} currentColor` : undefined;
    const style: CSSProperties = {
        textAlign: p.align,
        marginTop: p.spaceBefore ? `${p.spaceBefore}pt` : undefined,
        marginBottom: p.spaceAfter ? `${p.spaceAfter}pt` : undefined,
        lineHeight: p.lineSpacing && p.lineSpacing < 0 ? `${-p.lineSpacing}pt` : undefined,
        paddingLeft: p.indentLeft ? `${p.indentLeft}pt` : undefined,
        paddingRight: p.indentRight ? `${p.indentRight}pt` : undefined,
        textIndent: p.indentFirst ? `${p.indentFirst}pt` : undefined,
        borderTop: b?.top ? line : undefined,
        borderLeft: b?.left ? line : undefined,
        borderBottom: b?.bottom ? line : undefined,
        borderRight: b?.right ? line : undefined,
    };
    return (
        <div className='doc-paragraph' ref={ref} style={style}>
            {p.runs.length ? p.runs.map((r, i) => <Run key={i} run={r} preview={preview} go={go} />) : ' '}
        </div>
    );
}

function Run({ run, preview, go }: { run: DocumentRun; preview: DocumentData; go: Go }): ReactNode {
    switch (run.kind) {
        case 'break':
            return <br />;
        case 'tab':
            return <span className='doc-tab' />;
        case 'object':
            return <span className='doc-object'>{run.text}</span>;
        case 'text': {
            const text = <span style={css(preview.styles[run.style])}>{run.text}</span>;
            return run.link ? (
                <Hotspot link={run.link} go={go}>
                    {text}
                </Hotspot>
            ) : (
                text
            );
        }
        case 'picture': {
            const picture = preview.pictures[run.picture];
            const drawn = picture ? <Picture picture={picture} go={go} /> : null;
            return (
                <span className={`doc-picture doc-picture--${run.place}`}>
                    {run.link ? (
                        <Hotspot link={run.link} go={go}>
                            {drawn}
                        </Hotspot>
                    ) : (
                        drawn
                    )}
                </span>
            );
        }
    }
}

function Hotspot({ link, go, children }: { link: DocumentLink; go: Go; children: ReactNode }) {
    const follow = (e: MouseEvent) => {
        e.stopPropagation();
        go(link, below(e.currentTarget));
    };
    return (
        <button type='button' className={`doc-hotspot${link.page === undefined ? ' is-dead' : ''}`} title={link.about} onClick={follow}>
            {children}
        </button>
    );
}

function Picture({ picture, go }: { picture: DocumentPicture; go: Go }) {
    const canvas = useRef<HTMLCanvasElement>(null);
    useEffect(() => {
        const c = canvas.current;
        if (!c || !picture.rgba) return;
        c.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(picture.rgba), picture.width, picture.height), 0, 0);
    }, [picture]);
    if (!picture.rgba)
        return (
            <span className='doc-object' style={{ display: 'inline-block', width: picture.width, height: picture.height }}>
                [{picture.about}]
            </span>
        );
    return (
        <span className='doc-picture-frame'>
            <canvas ref={canvas} width={picture.width} height={picture.height} />
            {picture.hotspots.map((h, i) => (
                <button
                    type='button'
                    key={i}
                    className={`doc-picture-hotspot${h.link.page === undefined ? ' is-dead' : ''}`}
                    style={{ left: h.x, top: h.y, width: h.width, height: h.height }}
                    title={h.link.about}
                    aria-label={h.link.about}
                    onClick={(e) => {
                        e.stopPropagation();
                        go(h.link, below(e.currentTarget));
                    }}
                />
            ))}
        </span>
    );
}
