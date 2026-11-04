import { useMemo, useRef, useState } from 'react';
import { Alert, Button, Form, Spinner } from 'react-bootstrap';
import { formatSize, hex } from '../core/bytes';
import type { Entry } from '../core/types';
import { Muted, Tip } from '../components/ui';
import { download, safeName } from '../lib/download';
import { openEntry, typeEntries, type OpenFile, type TypedEntry } from '../lib/inspect';
import { zip } from '../lib/zip';
import { readNameList } from '../formats/mix/names';

const PAGE = 500;

type SortKey = 'index' | 'name' | 'type' | 'size' | 'offset';

/** The files inside an archive: find them, open them, save them. */
export function ContentsTab({
    archiveName,
    entries,
    names,
    onOpen,
    onNames,
}: {
    archiveName: string;
    entries: Entry[];
    names: readonly string[];
    onOpen: (file: OpenFile) => void;
    onNames: (names: string[]) => void;
}) {
    const typed = useMemo(() => typeEntries(entries), [entries]);
    const [filter, setFilter] = useState('');
    const [type, setType] = useState('');
    const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({ key: 'index', descending: false });
    const [shown, setShown] = useState(PAGE);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<string | null>(null);
    const nameInput = useRef<HTMLInputElement>(null);
    const metaColumns = useMemo(() => [...new Set(entries.flatMap((e) => Object.keys(e.meta ?? {})))], [entries]);
    const types = useMemo(() => [...new Map(typed.map((t) => [t.format.id, t.format.name])).entries()].sort((a, b) => a[1].localeCompare(b[1])), [typed]);

    const rows = useMemo(() => {
        const needle = filter.trim().toLowerCase();
        const list = typed
            .map((t, index) => ({ ...t, index }))
            .filter((t) => (!type || t.format.id === type) && (!needle || t.fileName.toLowerCase().includes(needle) || Object.values(t.entry.meta ?? {}).some((v) => v.toLowerCase().includes(needle))));
        const value = (t: (typeof list)[number]): string | number =>
            ({ index: t.index, name: t.fileName.toLowerCase(), type: t.format.name, size: t.entry.size, offset: t.entry.offset })[sort.key];
        list.sort((a, b) => {
            const x = value(a);
            const y = value(b);
            const order = x < y ? -1 : x > y ? 1 : 0;
            return sort.descending ? -order : order;
        });
        return list;
    }, [typed, filter, type, sort]);

    const known = entries.filter((e) => e.name).length;

    const extract = (list: TypedEntry[], label: string) => {
        setBusy(true);
        // Let the spinner paint: checksumming hundreds of megabytes takes a moment.
        setTimeout(() => {
            try {
                download(zip(list.map((t) => ({ name: safeName(t.fileName), data: t.entry.data }))), `${archiveName.replace(/\.[^.]+$/, '')}${label}.zip`);
            } catch (e) {
                setMessage(e instanceof Error ? e.message : String(e));
            } finally {
                setBusy(false);
            }
        }, 30);
    };

    const loadNames = async (file: File | undefined) => {
        if (!file) return;
        const added = readNameList(new Uint8Array(await file.arrayBuffer()));
        onNames([...new Set([...names, ...added])]);
        setMessage(`Added ${added.length.toLocaleString('en-US')} names from ${file.name}.`);
    };

    const header = (key: SortKey, label: string, className = '') => (
        <th className={`sortable ${className}`} onClick={() => setSort((s) => ({ key, descending: s.key === key ? !s.descending : false }))} aria-sort={sort.key === key ? (sort.descending ? 'descending' : 'ascending') : undefined}>
            {label}
            {sort.key === key && <i className={`bi ms-1 ${sort.descending ? 'bi-caret-down-fill' : 'bi-caret-up-fill'}`} />}
        </th>
    );

    return (
        <>
            <div className="d-flex flex-wrap gap-2 align-items-center mb-3">
                <Form.Control className="contents-filter" placeholder="Filter by name or ID" value={filter} onChange={(e) => setFilter(e.target.value)} />
                <Form.Select className="contents-type" value={type} onChange={(e) => setType(e.target.value)} aria-label="Type">
                    <option value="">All types</option>
                    {types.map(([id, name]) => (
                        <option key={id} value={id}>
                            {name}
                        </option>
                    ))}
                </Form.Select>
                <div className="ms-auto d-flex flex-wrap gap-2">
                    <Tip label={`${known} of ${entries.length} names are known. MIX files store only a hash of each name, so names come from a list. Load XCC's "global mix database.dat", a text file with one name per line, or the game's executable (TS's Game.exe, RA2's gamemd.exe), which names files no INI does.${names.length ? `\n\n${names.length.toLocaleString('en-US')} names loaded.` : ''}`}>
                        <Button variant="outline-light" onClick={() => nameInput.current?.click()}>
                            <i className="bi bi-tags me-1" /> Add names…
                        </Button>
                    </Tip>
                    {rows.length !== typed.length && (
                        <Button variant="outline-light" disabled={busy || rows.length === 0} onClick={() => extract(rows, ' (filtered)')}>
                            <i className="bi bi-file-zip me-1" /> Extract {rows.length} shown
                        </Button>
                    )}
                    <Button variant="primary" disabled={busy} onClick={() => extract(typed, '')}>
                        {busy ? <Spinner animation="border" size="sm" className="me-1" /> : <i className="bi bi-file-zip me-1" />} Extract all
                    </Button>
                </div>
                <input ref={nameInput} type="file" hidden onChange={(e) => void loadNames(e.target.files?.[0]).finally(() => (e.target.value = ''))} />
            </div>

            {message && (
                <Alert variant="secondary" className="py-2" dismissible onClose={() => setMessage(null)}>
                    {message}
                </Alert>
            )}

            <div className="table-responsive">
                <table className="table table-sm table-hover align-middle contents-table">
                    <thead>
                        <tr>
                            {header('index', '#', 'text-end')}
                            {header('name', 'Name')}
                            {header('type', 'Type')}
                            {header('size', 'Size', 'text-end')}
                            {header('offset', 'Offset', 'text-end')}
                            {metaColumns.map((c) => (
                                <th key={c}>{c}</th>
                            ))}
                            <th className="text-end">
                                <span className="visually-hidden">Actions</span>
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.slice(0, shown).map((t) => (
                            <tr key={t.index} className="contents-row" onDoubleClick={() => onOpen(openEntry(t))}>
                                <td className="text-end text-body-secondary">{t.index + 1}</td>
                                <td>
                                    <button type="button" className="btn btn-link p-0 text-reset text-decoration-none entry-name" onClick={() => onOpen(openEntry(t))}>
                                        {t.entry.name ?? (
                                            <Tip label="The real name isn't known; this is the file's ID and the type it looks like.">
                                                <span className="entry-unnamed">{t.fileName}</span>
                                            </Tip>
                                        )}
                                    </button>
                                </td>
                                <td>{t.format.id === 'raw' ? <Muted>Unknown</Muted> : t.format.name}</td>
                                <td className="text-end text-nowrap">{formatSize(t.entry.size)}</td>
                                <td className="text-end font-monospace small text-body-secondary">{hex(t.entry.offset)}</td>
                                {metaColumns.map((c) => (
                                    <td key={c} className="font-monospace small">
                                        {t.entry.meta?.[c]}
                                    </td>
                                ))}
                                <td className="text-end text-nowrap">
                                    <Tip label="Open">
                                        <button type="button" className="btn btn-sm btn-icon" onClick={() => onOpen(openEntry(t))} aria-label={`Open ${t.fileName}`}>
                                            <i className="bi bi-box-arrow-in-right" />
                                        </button>
                                    </Tip>
                                    <Tip label="Save">
                                        <button type="button" className="btn btn-sm btn-icon" onClick={() => download(t.entry.data, safeName(t.fileName))} aria-label={`Save ${t.fileName}`}>
                                            <i className="bi bi-download" />
                                        </button>
                                    </Tip>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            {rows.length > shown && (
                <Button variant="link" onClick={() => setShown((n) => n + PAGE)}>
                    Show {Math.min(PAGE, rows.length - shown)} more of {rows.length - shown}
                </Button>
            )}
            {rows.length === 0 && <p className="text-body-secondary">Nothing matches.</p>}
        </>
    );
}
