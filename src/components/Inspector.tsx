import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Nav, Spinner, Tab } from 'react-bootstrap';
import { bytesLabel, formatSize } from '../core/bytes';
import { download, safeName } from '../lib/download';
import { useParsed, type OpenFile } from '../lib/inspect';
import { useLibrary } from '../lib/library';
import { findPalettes, preferred } from '../lib/palette-sources';
import { usePalettes } from '../lib/palettes';
import { ContentsTab } from '../tabs/ContentsTab';
import { PreviewTab } from '../tabs/PreviewTab';
import { StructureTab } from '../tabs/StructureTab';
import { Dl } from './ui';

type TabKey = 'contents' | 'preview' | 'structure';

/** One file, whatever it is: what it holds, what it looks like, and how its bytes are laid out. */
export function Inspector({
    file,
    root,
    near,
    names,
    onOpen,
    onNames,
}: {
    file: OpenFile;
    /** Opened from disk, rather than from inside another file. */
    root: boolean;
    /** The archive it came out of, as a path ("MAIN.MIX › general.mix"). */
    near?: string;
    names: readonly string[];
    onOpen: (file: OpenFile) => void;
    onNames: (names: string[]) => void;
}) {
    const library = useLibrary();
    const { find: findAnywhere, add: addToLibrary } = library;
    const find = useCallback((name: string) => findAnywhere(name, near), [findAnywhere, near]);
    const state = useParsed(file, names, { find, version: library.version });
    const [tab, setTab] = useState<TabKey | null>(null);
    const { add } = usePalettes();

    // Files opened from disk, and what's in them, are there for other files to use (a map's tiles).
    useEffect(() => {
        if (root) void addToLibrary(file.name, file.data);
    }, [root, file, addToLibrary]);

    // Palettes in an archive are what its sprites are meant to be seen with. A newly opened
    // file's own palette replaces one from an earlier file (Red Alert's differ from TD's).
    useEffect(() => {
        if (state.status !== 'ready' || state.format.id !== 'mix') return;
        let cancelled = false;
        void findPalettes(file.name, file.data, names).then((found) => {
            if (cancelled || !found.length) return;
            const best = preferred(found)!;
            add([best, ...found.filter((p) => p !== best)], root);
        });
        return () => {
            cancelled = true;
        };
    }, [state, file, names, add, root]);

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
                    {parsed.wanted && <Wanted text={parsed.wanted} />}

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

/** A note that another file would show more, and a way to add it without leaving this one. */
function Wanted({ text }: { text: string }) {
    const { add } = useLibrary();
    const input = useRef<HTMLInputElement>(null);
    const [result, setResult] = useState<string | null>(null);

    const load = async (files: FileList | null) => {
        if (!files?.length) return;
        let added = 0;
        for (const f of files) added += await add(f.name, new Uint8Array(await f.arrayBuffer()));
        setResult(`Added ${added.toLocaleString('en-US')} file${added === 1 ? '' : 's'}.`);
    };

    return (
        <Alert variant="info" className="py-2 small d-flex flex-wrap align-items-center gap-2">
            <span className="me-auto">
                <i className="bi bi-info-circle me-1" />
                {text} {result && <span className="text-body-secondary">{result}</span>}
            </span>
            <Button size="sm" variant="outline-light" onClick={() => input.current?.click()}>
                <i className="bi bi-plus-lg me-1" /> Add files…
            </Button>
            <input ref={input} type="file" multiple hidden onChange={(e) => void load(e.target.files).finally(() => (e.target.value = ''))} />
        </Alert>
    );
}
