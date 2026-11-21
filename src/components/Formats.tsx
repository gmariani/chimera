import { useState } from 'react';
import { Button, ButtonGroup, Form, Modal, Table } from 'react-bootstrap';
import { FORMATS } from '../formats';
import { CHECKS, DEPTHS, SCORECARDS, type Depth, type Scorecard } from '../formats/scorecards';
import { SectionBar } from './ui';

const ORDER: Depth[] = ['thorough', 'solid', 'partial', 'early'];

/** Each format once, by name (some names cover several parsers, e.g. the sprite variants), with the shallowest of their scorecards. */
function formatList() {
    const byName = new Map<string, { extensions: Set<string>; card?: Scorecard }>();
    for (const f of FORMATS) {
        const entry = byName.get(f.name) ?? { extensions: new Set<string>() };
        for (const e of f.extensions) entry.extensions.add(e);
        const card = SCORECARDS[f.id];
        if (card && (!entry.card || ORDER.indexOf(card.depth) > ORDER.indexOf(entry.card.depth))) entry.card = card;
        byName.set(f.name, entry);
    }
    return [...byName].map(([name, e]) => ({ name, extensions: [...e.extensions], card: e.card })).sort((a, b) => a.name.localeCompare(b.name));
}

/** The registry doesn't change while the page is open, so the list is made once. */
const FORMAT_LIST = formatList();

/**
 * The formats the app reads, gliding slowly past (still, for anyone who asks
 * their system for less motion). Clicking it shows the whole list, which
 * would take too much room to show by default as it grows.
 */
export function FormatsCarousel() {
    const formats = FORMAT_LIST;
    const [open, setOpen] = useState(false);
    // Twice over, so the strip loops without a seam; about four seconds a format.
    const chips = (copy: number) =>
        formats.map((f) => (
            <span key={`${copy}-${f.name}`} className='format-chip' aria-hidden={copy > 0 || undefined}>
                {f.name} <span className='opacity-75'>.{f.extensions.slice(0, 2).join(', .')}</span>
            </span>
        ));
    return (
        <>
            <SectionBar index='02' title='Formats'>
                {formats.length} formats ·{' '}
                <Button variant='link' size='sm' className='p-0 section-link' onClick={() => setOpen(true)}>
                    See all
                </Button>
            </SectionBar>
            {/* A real button, so Enter and Space work without help; a button holds only spans, hence no list. */}
            <button type='button' className='format-carousel' aria-label={`The ${formats.length} formats it reads; open the full list`} onClick={() => setOpen(true)}>
                <span className='format-track small text-body-secondary' style={{ animationDuration: `${formats.length * 4}s` }}>
                    {chips(0)}
                    {chips(1)}
                </span>
            </button>
            <FormatsModal show={open} onHide={() => setOpen(false)} />
        </>
    );
}

function FormatsModal({ show, onHide }: { show: boolean; onHide: () => void }) {
    const formats = FORMAT_LIST;
    const [filter, setFilter] = useState('');
    const [depth, setDepth] = useState<Depth | null>(null);
    const needle = filter.trim().toLowerCase().replace(/^\./, '');
    const shown = formats.filter((f) => (!depth || f.card?.depth === depth) && (!needle || f.name.toLowerCase().includes(needle) || f.extensions.some((e) => e.includes(needle))));
    const count = (d: Depth) => formats.filter((f) => f.card?.depth === d).length;
    return (
        <Modal show={show} onHide={onHide} size='lg' scrollable centered>
            <Modal.Header closeButton>
                <Modal.Title className='h5'>Formats it reads</Modal.Title>
            </Modal.Header>
            <Modal.Body>
                <Form.Control
                    type='search'
                    placeholder='Filter by name or extension'
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    className='mb-2'
                    // The dialog takes focus anyway; the filter is where someone typing wants it.
                    // oxlint-disable-next-line jsx-a11y/no-autofocus
                    autoFocus
                />
                <ButtonGroup size='sm' className='mb-3 flex-wrap' aria-label='How far each reader goes'>
                    <Button variant='outline-light' active={!depth} onClick={() => setDepth(null)}>
                        All {formats.length}
                    </Button>
                    {ORDER.map((d) => (
                        <Button key={d} variant='outline-light' active={depth === d} onClick={() => setDepth(depth === d ? null : d)} title={DEPTHS[d]}>
                            {d} {count(d)}
                        </Button>
                    ))}
                </ButtonGroup>
                <Table size='sm' hover className='small mb-2'>
                    <thead>
                        <tr>
                            <th>Format</th>
                            <th>Extensions</th>
                            <th>Mapped</th>
                            <th>Checked</th>
                        </tr>
                    </thead>
                    <tbody>
                        {shown.map((f) => (
                            <tr key={f.name}>
                                <td>
                                    {f.name}
                                    {f.card && (
                                        <div className='scorecard-notes text-body-secondary'>
                                            Reads {f.card.reads}.{f.card.missing && <> Not yet: {f.card.missing}.</>} Checked against {f.card.against}.
                                        </div>
                                    )}
                                </td>
                                <td className='text-body-secondary'>.{f.extensions.join(', .')}</td>
                                <td>
                                    {f.card && (
                                        <span className={`scorecard-chip scorecard-chip--${f.card.depth}`} title={DEPTHS[f.card.depth]}>
                                            {f.card.depth}
                                        </span>
                                    )}
                                </td>
                                <td className='text-body-secondary text-nowrap' title={f.card && CHECKS[f.card.checked]}>
                                    {f.card?.checked}
                                </td>
                            </tr>
                        ))}
                        {!shown.length && (
                            <tr>
                                <td colSpan={4} className='text-body-secondary'>
                                    None by that name. It will still open, in the hex view.
                                </td>
                            </tr>
                        )}
                    </tbody>
                </Table>
                <dl className='scorecard-key small text-body-secondary mb-2'>
                    {ORDER.map((d) => (
                        <div key={d}>
                            <dt>
                                <span className={`scorecard-chip scorecard-chip--${d}`}>{d}</span>
                            </dt>
                            <dd>{DEPTHS[d]}</dd>
                        </div>
                    ))}
                    {(Object.keys(CHECKS) as (keyof typeof CHECKS)[]).map((c) => (
                        <div key={c}>
                            <dt>{c}</dt>
                            <dd>{CHECKS[c]}</dd>
                        </div>
                    ))}
                </dl>
                <p className='small text-body-secondary mb-0'>Files are recognized by their contents, so the extension doesn't have to match. Anything it doesn't recognize opens in the hex view.</p>
            </Modal.Body>
        </Modal>
    );
}
