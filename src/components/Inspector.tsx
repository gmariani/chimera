import { useEffect, useState } from 'react';
import { Alert, Button, Nav, Spinner, Tab } from 'react-bootstrap';
import { bytesLabel, formatSize } from '../core/bytes';
import { download, safeName } from '../lib/download';
import { useParsed, type OpenFile } from '../lib/inspect';
import { findPalettes } from '../lib/palette-sources';
import { usePalettes } from '../lib/palettes';
import { ContentsTab } from '../tabs/ContentsTab';
import { PreviewTab } from '../tabs/PreviewTab';
import { StructureTab } from '../tabs/StructureTab';
import { Dl } from './ui';

type TabKey = 'contents' | 'preview' | 'structure';

/** One file, whatever it is: what it holds, what it looks like, and how its bytes are laid out. */
export function Inspector({ file, names, onOpen, onNames }: { file: OpenFile; names: readonly string[]; onOpen: (file: OpenFile) => void; onNames: (names: string[]) => void }) {
    const state = useParsed(file, names);
    const [tab, setTab] = useState<TabKey | null>(null);
    const { add } = usePalettes();

    // Palettes in an archive are what its sprites are meant to be seen with.
    useEffect(() => {
        if (state.status !== 'ready' || state.format.id !== 'mix') return;
        let cancelled = false;
        void findPalettes(file.name, file.data, names).then((found) => !cancelled && add(found));
        return () => {
            cancelled = true;
        };
    }, [state, file, names, add]);

    const parsed = state.status === 'ready' ? state.parsed : null;
    const available: TabKey[] = parsed ? [...(parsed.entries ? ['contents' as const] : []), ...(parsed.preview ? ['preview' as const] : []), 'structure'] : [];
    const active = tab && available.includes(tab) ? tab : available[0];

    return (
        <>
            <div className="text-center mb-4">
                <h1 className="display-6 bd-title mb-1 text-break">{file.name}</h1>
                <p className="text-body-secondary mb-2">
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

            {state.status === 'error' && (
                <Alert variant="warning">
                    This looked like {state.format.name.toLowerCase()}, but couldn't be read as one: {state.error}
                </Alert>
            )}

            {parsed && (
                <>
                    {parsed.warnings.slice(0, 5).map((w) => (
                        <Alert key={w} variant="warning" className="py-2 small">
                            {w}
                        </Alert>
                    ))}
                    {parsed.warnings.length > 5 && <Alert variant="warning" className="py-2 small">…and {parsed.warnings.length - 5} more problems.</Alert>}

                    <div className="summary mx-auto mb-4">
                        <Dl rows={parsed.summary.map(([k, v]) => [k, v])} labelCols={4} className="facts mb-0" />
                    </div>

                    <Tab.Container activeKey={active} onSelect={(key) => key && setTab(key as TabKey)} mountOnEnter>
                        <Nav variant="pills" className="mb-3 justify-content-center" role="tablist">
                            {available.map((key) => (
                                <Nav.Item key={key}>
                                    <Nav.Link eventKey={key}>{{ contents: `Contents (${parsed.entries?.length ?? 0})`, preview: 'Preview', structure: 'Structure' }[key]}</Nav.Link>
                                </Nav.Item>
                            ))}
                        </Nav>
                        <Tab.Content>
                            {parsed.entries && (
                                <Tab.Pane eventKey="contents">
                                    <ContentsTab archiveName={file.name} entries={parsed.entries} names={names} onOpen={onOpen} onNames={onNames} />
                                </Tab.Pane>
                            )}
                            {parsed.preview && (
                                <Tab.Pane eventKey="preview">
                                    <PreviewTab preview={parsed.preview} fileName={file.name} names={names} />
                                </Tab.Pane>
                            )}
                            <Tab.Pane eventKey="structure">
                                <StructureTab data={file.data} parsed={parsed} fileName={file.name} />
                            </Tab.Pane>
                        </Tab.Content>
                    </Tab.Container>
                </>
            )}

            {state.status === 'error' && <StructureTab data={file.data} parsed={{ title: '', summary: [], fields: [], warnings: [] }} fileName={file.name} />}
        </>
    );
}
