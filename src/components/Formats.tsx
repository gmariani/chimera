import { useMemo, useState } from 'react';
import { Button, Form, Modal, Table } from 'react-bootstrap';
import { FORMATS } from '../formats';
import { SectionBar } from './ui';

/** Each format once, by name (some names cover several parsers, e.g. the sprite variants). */
function formatList() {
    const byName = new Map<string, Set<string>>();
    for (const f of FORMATS) {
        const exts = byName.get(f.name) ?? new Set<string>();
        for (const e of f.extensions) exts.add(e);
        byName.set(f.name, exts);
    }
    return [...byName].map(([name, exts]) => ({ name, extensions: [...exts] })).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The formats the app reads, gliding slowly past (still, for anyone who asks
 * their system for less motion). Clicking it shows the whole list, which
 * would take too much room to show by default as it grows.
 */
export function FormatsCarousel() {
    const formats = useMemo(formatList, []);
    const [open, setOpen] = useState(false);
    // Twice over, so the strip loops without a seam; about four seconds a format.
    const chips = (copy: number) =>
        formats.map((f) => (
            <li key={`${copy}-${f.name}`} className="format-chip" aria-hidden={copy > 0 || undefined}>
                {f.name} <span className="opacity-75">.{f.extensions.slice(0, 2).join(', .')}</span>
            </li>
        ));
    return (
        <>
            <SectionBar index="02" title="Formats">
                {formats.length} formats ·{' '}
                <Button variant="link" size="sm" className="p-0 section-link" onClick={() => setOpen(true)}>
                    See all
                </Button>
            </SectionBar>
            <div className="format-carousel" role="button" tabIndex={0} aria-label={`The ${formats.length} formats it reads; open the full list`} onClick={() => setOpen(true)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setOpen(true))}>
                <ul className="format-track small text-body-secondary" style={{ animationDuration: `${formats.length * 4}s` }}>
                    {chips(0)}
                    {chips(1)}
                </ul>
            </div>
            <FormatsModal show={open} onHide={() => setOpen(false)} />
        </>
    );
}

function FormatsModal({ show, onHide }: { show: boolean; onHide: () => void }) {
    const formats = useMemo(formatList, []);
    const [filter, setFilter] = useState('');
    const needle = filter.trim().toLowerCase().replace(/^\./, '');
    const shown = needle ? formats.filter((f) => f.name.toLowerCase().includes(needle) || f.extensions.some((e) => e.includes(needle))) : formats;
    return (
        <Modal show={show} onHide={onHide} size="lg" scrollable centered>
            <Modal.Header closeButton>
                <Modal.Title className="h5">Formats it reads</Modal.Title>
            </Modal.Header>
            <Modal.Body>
                <Form.Control type="search" placeholder="Filter by name or extension" value={filter} onChange={(e) => setFilter(e.target.value)} className="mb-3" autoFocus />
                <Table size="sm" hover className="small mb-2">
                    <thead>
                        <tr>
                            <th>Format</th>
                            <th>Extensions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {shown.map((f) => (
                            <tr key={f.name}>
                                <td>{f.name}</td>
                                <td className="text-body-secondary">.{f.extensions.join(', .')}</td>
                            </tr>
                        ))}
                        {!shown.length && (
                            <tr>
                                <td colSpan={2} className="text-body-secondary">
                                    None by that name. It will still open, in the hex view.
                                </td>
                            </tr>
                        )}
                    </tbody>
                </Table>
                <p className="small text-body-secondary mb-0">Files are recognized by their contents, so the extension doesn't have to match. Anything it doesn't recognize opens in the hex view.</p>
            </Modal.Body>
        </Modal>
    );
}
