import { useCallback, useEffect, useRef } from 'react';
import { Alert, Button, Nav, Spinner, Tab } from 'react-bootstrap';
import type { FormatDescriptor } from '../core/types';
import type { Check } from '../formats/inspect';
import { bytesLabel, formatSize } from '../core/bytes';
import { download, safeName } from '../lib/download';
import { useParsed, type OpenFile } from '../lib/inspect';
import { useLibrary } from '../lib/library';
import { useRemembered, type ViewMemory } from '../lib/view-memory';
import { findPalettes, preferred } from '../lib/palette-sources';
import { usePalettes } from '../lib/palettes';
import { ContentsTab } from '../tabs/ContentsTab';
import { PreviewTab } from '../tabs/PreviewTab';
import { LinksTab } from '../tabs/LinksTab';
import { StructureTab } from '../tabs/StructureTab';
import { AddFilesButton } from './AddFiles';
import { Guard } from './Guard';
import { Dl } from './ui';

type TabKey = 'contents' | 'preview' | 'links' | 'structure';

/** One file, whatever it is: what it holds, what it looks like, and how its bytes are laid out. */
export function Inspector({
    file,
    root,
    near,
    names,
    memory,
    onOpen,
    onOpenAs,
    onNames,
    onShowFiles,
}: {
    file: OpenFile;
    /** Opened from disk, rather than from inside another file. */
    root: boolean;
    /** The archive it came out of, as a path ("MAIN.MIX › general.mix"). */
    near?: string;
    /** What the user had set on this page, kept while they look inside one of its files. */
    memory?: ViewMemory;
    names: readonly string[];
    onOpen: (file: OpenFile) => void;
    /** Shows this file as another format instead (or, with no format, as detected). */
    onOpenAs: (format: string | undefined) => void;
    onNames: (names: string[]) => void;
    /** Opens the list of files in use this session. */
    onShowFiles: () => void;
}) {
    const library = useLibrary();
    const { find: findAnywhere, add: addToLibrary, idOf } = library;
    const find = useCallback((name: string) => findAnywhere(name, near), [findAnywhere, near]);
    // The user's names and those learned from opened archives' INIs; `names` alone is what the user can edit.
    const allNames = library.names;
    const state = useParsed(file, allNames, { find, version: library.version });
    const [tab, setTab] = useRemembered<TabKey | null>(memory, 'tab', null);
    const { add } = usePalettes();

    // Files opened from disk, and what's in them, are there for other files to use (a map's tiles).
    // Once per file: if the user removes it from the files in use, it stays removed.
    const registered = useRef<OpenFile | null>(null);
    useEffect(() => {
        if (!root || registered.current === file) return;
        registered.current = file;
        void addToLibrary(file.name, file.data, 'opened');
    }, [root, file, addToLibrary]);

    // Palettes in an archive are what its sprites are meant to be seen with. A newly opened
    // file's own palette replaces one from an earlier file (Red Alert's differ from TD's).
    useEffect(() => {
        if (state.status !== 'ready' || state.format.id !== 'mix') return;
        let canceled = false;
        // Listed while the file in use they're in is: this one, or the one it was opened from.
        const owner = near ? near.split(' › ')[0] : idOf(file.data) ?? file.name;
        void findPalettes(file.name, file.data, allNames).then((found) => {
            if (canceled || !found.length) return;
            const best = preferred(found)!;
            add([best, ...found.filter((p) => p !== best)].map((p) => ({ ...p, owner })), root);
        });
        return () => {
            canceled = true;
        };
    }, [state, file, allNames, add, root, near, idOf]);

    const parsed = state.status === 'ready' ? state.parsed : null;
    const checks = state.status === 'ready' ? state.checks : [];
    const alternatives = state.status === 'ready' ? state.alternatives : [];

    // Coming back from a file inside this one: back to where the user had scrolled, once the page is drawn.
    const ready = parsed !== null;
    useEffect(() => {
        const y = memory?.get('scroll');
        if (!ready || typeof y !== 'number') return;
        const frame = requestAnimationFrame(() => window.scrollTo(0, y));
        return () => cancelAnimationFrame(frame);
    }, [ready, memory]);
    const openInside = (inner: OpenFile) => {
        memory?.set('scroll', window.scrollY);
        onOpen(inner);
    };
    /** Opens the first of these files found among the files in use (a unit's sprite, from a rules table). */
    const openName = (candidates: string[]) => {
        for (const name of candidates) {
            const found = find(name)[0];
            if (found) {
                openInside({ name, knownName: name, data: found.data });
                return true;
            }
        }
        return false;
    };
    const links = parsed?.links ?? [];
    const missing = links.filter((l) => !l.source).length;
    const available: TabKey[] = parsed ? [...(parsed.entries ? ['contents' as const] : []), ...(parsed.preview ? ['preview' as const] : []), ...(links.length ? ['links' as const] : []), 'structure'] : [];
    // A file with a preview opens on it, even when it holds files too (a photo's thumbnail).
    const active = tab && available.includes(tab) ? tab : available.includes('preview') ? 'preview' : available[0];

    return (
        <>
            <div className="text-center mb-4">
                <h1 className="display-6 bd-title mb-1 text-break">{file.name}</h1>
                <p className="text-body-secondary mb-2">
                    {checks.some((c) => c.level === 'danger') && (
                        <span className="badge text-bg-danger me-2">
                            <i className="bi bi-shield-exclamation me-1" />
                            Not what it claims
                        </span>
                    )}
                    {parsed ? parsed.title : state.format.name} · {formatSize(file.data.length)}
                    {!file.knownName && ' · real name unknown'}
                </p>
                <Button size="sm" variant="outline-light" onClick={() => download(file.data, safeName(file.name))}>
                    <i className="bi bi-download me-1" /> Save this file
                </Button>
            </div>

            {state.status === 'loading' && (
                <div className="section-loading justify-content-center" aria-busy="true">
                    <Spinner animation="border" size="sm" role="status" /> <span>Reading {bytesLabel(file.data.length)}…</span>
                </div>
            )}

            {parsed && (
                <>
                    <Checks checks={checks} alternatives={alternatives} openedAs={file.as} onOpenAs={onOpenAs} />
                    {parsed.warnings.slice(0, 5).map((w) => (
                        <Alert key={w} variant="warning" className="py-2 small">
                            {w}
                        </Alert>
                    ))}
                    {parsed.warnings.length > 5 && <Alert variant="warning" className="py-2 small">…and {parsed.warnings.length - 5} more problems.</Alert>}
                    {parsed.wanted && <Wanted text={parsed.wanted} />}
                    {missing > 0 && !parsed.wanted && (
                        <Alert variant="info" className="py-2 small d-flex flex-wrap align-items-center gap-2">
                            <span className="me-auto">
                                <i className="bi bi-link-45deg me-1" />
                                {missing} file{missing === 1 ? '' : 's'} this would use {missing === 1 ? 'isn\'t' : 'aren\'t'} in the files in use, so {missing === 1 ? 'it isn\'t' : 'they aren\'t'} shown.
                            </span>
                            <Button size="sm" variant="outline-light" onClick={() => setTab('links')}>
                                See which
                            </Button>
                        </Alert>
                    )}

                    <div className="summary mx-auto mb-4">
                        <Dl rows={parsed.summary.map(([k, v]) => [k, v])} labelCols={4} className="facts mb-0" />
                    </div>

                    <Tab.Container activeKey={active} onSelect={(key) => key && setTab(key as TabKey)} mountOnEnter>
                        <Nav variant="pills" className="mb-3 justify-content-center" role="tablist">
                            {available.map((key) => (
                                <Nav.Item key={key}>
                                    <Nav.Link eventKey={key}>
                                        {{ contents: `Contents (${parsed.entries?.length ?? 0})`, preview: 'Preview', links: `Linked files (${links.length})`, structure: 'Structure' }[key]}
                                        {key === 'links' && missing > 0 && (
                                            <span className="badge text-bg-warning ms-1" title={`${missing} not found`}>
                                                {missing} missing
                                            </span>
                                        )}
                                    </Nav.Link>
                                </Nav.Item>
                            ))}
                        </Nav>
                        <Tab.Content>
                            {parsed.entries && (
                                <Tab.Pane eventKey="contents">
                                    <Guard what="contents list">
                                        <ContentsTab archiveName={file.name} entries={parsed.entries} names={names} memory={memory} onOpen={openInside} onNames={onNames} />
                                    </Guard>
                                </Tab.Pane>
                            )}
                            {parsed.preview && (
                                <Tab.Pane eventKey="preview">
                                    <Guard what="preview">
                                        <PreviewTab preview={parsed.preview} fileName={file.name} names={allNames} onOpenName={openName} />
                                    </Guard>
                                </Tab.Pane>
                            )}
                            {links.length > 0 && (
                                <Tab.Pane eventKey="links">
                                    <Guard what="linked files list">
                                        <LinksTab links={links} onShowFiles={onShowFiles} />
                                    </Guard>
                                </Tab.Pane>
                            )}
                            <Tab.Pane eventKey="structure">
                                <Guard what="structure view">
                                    <StructureTab data={file.data} parsed={parsed} fileName={file.name} />
                                </Guard>
                            </Tab.Pane>
                        </Tab.Content>
                    </Tab.Container>
                </>
            )}
        </>
    );
}

const ICONS: Record<Check['level'], string> = { danger: 'bi-shield-exclamation', warning: 'bi-exclamation-triangle', info: 'bi-info-circle' };

/** What the checks every file gets found (is it what it claims, is anything hidden), and other ways to open it. */
function Checks({ checks, alternatives, openedAs, onOpenAs }: { checks: Check[]; alternatives: FormatDescriptor[]; openedAs?: string; onOpenAs: (format: string | undefined) => void }) {
    const suspicious = checks.some((c) => c.level !== 'info');
    return (
        <>
            {checks.map((c) => (
                <Alert key={c.text} variant={c.level} className="py-2 small">
                    <i className={`bi ${ICONS[c.level]} me-1`} />
                    {c.text}
                </Alert>
            ))}
            {(openedAs || (alternatives.length > 0 && suspicious)) && (
                <div className="d-flex flex-wrap align-items-center justify-content-center gap-2 mb-3 small">
                    <span className="text-body-secondary">Open as</span>
                    {openedAs && (
                        <Button size="sm" variant="outline-light" onClick={() => onOpenAs(undefined)}>
                            Detected format
                        </Button>
                    )}
                    {alternatives.map((f) => (
                        <Button key={f.id} size="sm" variant="outline-light" onClick={() => onOpenAs(f.id)}>
                            {f.name}
                        </Button>
                    ))}
                </div>
            )}
        </>
    );
}

/** A note that another file would show more, and a way to add it without leaving this one. */
function Wanted({ text }: { text: string }) {
    return (
        <Alert variant="info" className="py-2 small d-flex flex-wrap align-items-center gap-2">
            <span className="me-auto">
                <i className="bi bi-info-circle me-1" />
                {text}
            </span>
            <AddFilesButton />
        </Alert>
    );
}
