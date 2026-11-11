import { useEffect, useMemo, useRef, useState } from 'react';
import { Form } from 'react-bootstrap';
import { hex } from '../core/bytes';
import type { Field, Overlay } from '../core/types';
import { firstLeafAfter, type Leaf } from '../lib/fields';

const COLUMNS = 16;
const ROWS = 24;

/**
 * A hex dump that shows a window of rows and scrolls by row, so it works the
 * same on a 1 KB file and a 1 GB one. Bytes are tinted by the field they belong
 * to; the selected field is highlighted.
 */
export function HexView({
    data,
    leaves,
    overlays = [],
    selected,
    hovered,
    onPick,
}: {
    data: Uint8Array;
    leaves: Leaf[];
    overlays?: Overlay[];
    selected: Field | null;
    hovered: Field | null;
    onPick: (offset: number) => void;
}) {
    const totalRows = Math.max(1, Math.ceil(data.length / COLUMNS));
    const maxTop = Math.max(0, totalRows - ROWS);
    const [top, setTop] = useState(0);
    const [useOverlay, setUseOverlay] = useState(overlays.length > 0);
    const [goTo, setGoTo] = useState('');
    const box = useRef<HTMLElement>(null);
    const clamp = (row: number) => Math.max(0, Math.min(maxTop, row));

    // Bring the selected field into view.
    useEffect(() => {
        if (!selected) return;
        const row = Math.floor(selected.offset / COLUMNS);
        setTop((t) => (row >= t && row < t + ROWS ? t : clamp(row - 2)));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selected]);

    // Wheel scrolling has to be non-passive to stop the page scrolling too.
    useEffect(() => {
        const el = box.current;
        if (!el) return;
        const wheel = (e: WheelEvent) => {
            e.preventDefault();
            const rows = Math.sign(e.deltaY) * Math.max(1, Math.round(Math.abs(e.deltaY) / 40)) * (e.shiftKey ? ROWS : 1);
            setTop((t) => Math.max(0, Math.min(maxTop, t + rows)));
        };
        el.addEventListener('wheel', wheel, { passive: false });
        return () => el.removeEventListener('wheel', wheel);
    }, [maxTop]);

    const byteAt = useMemo(() => {
        const active = useOverlay ? overlays : [];
        return (offset: number) => {
            for (const o of active) if (offset >= o.offset && offset < o.offset + o.bytes.length) return { value: o.bytes[offset - o.offset], overlaid: true };
            return { value: data[offset], overlaid: false };
        };
    }, [data, overlays, useOverlay]);

    const inRange = (f: Field | null, offset: number) => f !== null && offset >= f.offset && offset < f.offset + f.length;

    const rows = [];
    let leaf = firstLeafAfter(leaves, top * COLUMNS);
    for (let r = top; r < Math.min(totalRows, top + ROWS); r++) {
        const hexCells = [];
        const textCells = [];
        for (let c = 0; c < COLUMNS; c++) {
            const offset = r * COLUMNS + c;
            if (offset >= data.length) {
                hexCells.push(<span key={c} className='hx-byte hx-empty' />);
                continue;
            }
            while (leaf < leaves.length && leaves[leaf].end <= offset) leaf++;
            const tone = leaf < leaves.length && leaves[leaf].offset <= offset ? leaves[leaf].tone : -1;
            const { value, overlaid } = byteAt(offset);
            const classes = [
                'hx-byte',
                tone >= 0 ? `hx-tone-${tone}` : '',
                inRange(hovered, offset) ? 'hx-hover' : '',
                inRange(selected, offset) ? 'hx-selected' : '',
                overlaid ? 'hx-overlaid' : '',
            ].join(' ');
            hexCells.push(
                <span key={c} className={classes} data-offset={offset}>
                    {value.toString(16).padStart(2, '0')}
                </span>
            );
            textCells.push(
                <span key={c} className={classes} data-offset={offset}>
                    {value >= 32 && value < 127 ? String.fromCharCode(value) : '.'}
                </span>
            );
        }
        rows.push(
            <div key={r} className='hx-row'>
                <span className='hx-offset'>{hex(r * COLUMNS, 8)}</span>
                <span className='hx-hex'>{hexCells}</span>
                <span className='hx-text'>{textCells}</span>
            </div>
        );
    }

    const jump = () => {
        const text = goTo.trim();
        const offset = /^(0x|\$)/i.test(text) || /[a-f]/i.test(text) ? parseInt(text.replace(/^(0x|\$)/i, ''), 16) : parseInt(text, 10);
        if (Number.isFinite(offset) && offset >= 0 && offset < data.length) {
            setTop(clamp(Math.floor(offset / COLUMNS) - 2));
            onPick(offset);
        }
    };

    return (
        <div className='hex-view'>
            <div className='hex-toolbar'>
                <Form
                    className='d-flex gap-2 align-items-center'
                    onSubmit={(e) => {
                        e.preventDefault();
                        jump();
                    }}>
                    <Form.Control size='sm' className='hex-goto' placeholder='Go to offset (0x1A or 26)' value={goTo} onChange={(e) => setGoTo(e.target.value)} />
                </Form>
                {overlays.length > 0 && <Form.Check type='switch' id='hex-overlay' label={`Show ${overlays[0].label} bytes`} checked={useOverlay} onChange={(e) => setUseOverlay(e.target.checked)} />}
                <span className='text-body-secondary small ms-auto'>
                    {hex(top * COLUMNS, 8)}–{hex(Math.min(data.length, (top + ROWS) * COLUMNS) - 1 || 0, 8)} of {hex(data.length, 8)}
                </span>
            </div>
            <div className='hex-body'>
                {/* One focusable region that scrolls by keyboard, and picks the byte clicked (each says where it is). Making each of the
                    512 bytes focusable would be worse for keyboard users, who can pick one with "Go to offset" instead. */}
                {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- the region's keys scroll it, and a click picks a byte */}
                <section
                    ref={box}
                    className='hex-rows'
                    aria-label='Bytes: the arrow keys, Page Up and Page Down scroll'
                    // A region that scrolls has to be focusable for the keyboard to scroll it.
                    // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex
                    tabIndex={0}
                    onClick={(e) => {
                        const at = (e.target as HTMLElement).closest<HTMLElement>('[data-offset]')?.dataset.offset;
                        if (at !== undefined) onPick(Number(at));
                    }}
                    onKeyDown={(e) => {
                        const moves: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, PageDown: ROWS, PageUp: -ROWS, Home: -Infinity, End: Infinity };
                        if (e.key in moves) {
                            e.preventDefault();
                            setTop((t) => clamp(t + moves[e.key]));
                        }
                    }}>
                    {rows}
                </section>
                {maxTop > 0 && <input type='range' className='hex-scroll' min={0} max={maxTop} value={top} onChange={(e) => setTop(Number(e.target.value))} aria-label='Scroll through the file' />}
            </div>
        </div>
    );
}
