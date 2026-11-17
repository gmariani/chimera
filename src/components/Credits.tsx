import { useEffect, useState } from 'react';
import { Modal } from 'react-bootstrap';
import license from '../../LICENSE?raw';
import sources from '../../SOURCES.md?raw';
import ffmpeg from '../formats/westwood/bink-wasm/LICENSE.ffmpeg.md?raw';
import { noticeOf, portedFiles, sectionsWithout } from '../lib/credits';
import { inline, Markdown } from '../lib/markdown';
import { PORTED_SOURCES } from '../lib/notices';
import type { PackageLicense } from '../../scripts/licenses';

/**
 * Credits and licenses: Chimera's own, what it was made from (SOURCES.md), the notices of the code it carries from
 * other projects (read from the files that carry them), FFmpeg's in the Bink module, and every npm package in the
 * built site with its license (licenses.json, written when the site is built). Loaded only when it's opened.
 */

type Libraries = { state: 'loading' } | { state: 'ready'; list: PackageLicense[] } | { state: 'none' };

/** licenses.json beside the page; a copy that wasn't built (the dev server) has none. */
function useLibraries(show: boolean): Libraries {
    const [libraries, setLibraries] = useState<Libraries>({ state: 'loading' });
    useEffect(() => {
        if (!show || libraries.state !== 'loading') return;
        fetch('licenses.json')
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
            .then((list: PackageLicense[]) => setLibraries({ state: 'ready', list }))
            .catch(() => setLibraries({ state: 'none' }));
    }, [show, libraries.state]);
    return libraries;
}

function Text({ summary, children }: { summary: string; children: string }) {
    return (
        <details className='credits-text'>
            <summary>{summary}</summary>
            <pre>{children}</pre>
        </details>
    );
}

export function CreditsModal({ show, onHide }: { show: boolean; onHide: () => void }) {
    const libraries = useLibraries(show);
    const ported = portedFiles(sources);
    return (
        <Modal show={show} onHide={onHide} size='lg' scrollable centered>
            <Modal.Header closeButton>
                <Modal.Title className='h5'>Credits and licenses</Modal.Title>
            </Modal.Header>
            <Modal.Body className='credits'>
                <section>
                    <h3>Chimera</h3>
                    <p>
                        © {__BUILD_YEAR__} Gabriel Mariani. Chimera is free software: you can share it and change it under the terms of the GNU General Public License, version 3, and it comes with no
                        warranty. Its source carries the notices below.
                    </p>
                    <Text summary='The GNU General Public License, version 3'>{license}</Text>
                </section>

                <section>
                    <h3>Code from other projects</h3>
                    <p>Each keeps its authors’ notice, as the file that carries it has it.</p>
                    {ported.map((p) => {
                        const notice = p.file.startsWith('wasm/') ? ffmpeg : noticeOf(PORTED_SOURCES[p.file] ?? '');
                        return (
                            <div key={p.file} className='credits-item'>
                                <div>
                                    <code>{p.file}</code>: {inline(p.from)}, by {p.by}. {p.license}.
                                </div>
                                <Text summary={p.file.startsWith('wasm/') ? 'Its license note' : 'Its notice'}>{notice}</Text>
                            </div>
                        );
                    })}
                </section>

                <section>
                    <h3>Libraries</h3>
                    {libraries.state === 'loading' && <p className='text-body-secondary'>Reading the list…</p>}
                    {libraries.state === 'none' && <p className='text-body-secondary'>The list of libraries is made when the site is built, and this copy wasn’t built.</p>}
                    {libraries.state === 'ready' && (
                        <>
                            <p>Every package whose code is in this copy of the site, with its license as the package itself gives it.</p>
                            {libraries.list.map((l) => (
                                <div key={`${l.name}@${l.version}`} className='credits-item'>
                                    <div>
                                        <code>{l.name}</code> {l.version}: {l.license}.
                                    </div>
                                    <Text summary='Its license'>{l.notice ? `${l.text}\n\n${l.notice}` : l.text}</Text>
                                </div>
                            ))}
                        </>
                    )}
                </section>

                <section>
                    <h3>Sources</h3>
                    <Markdown text={sectionsWithout(sources, ['Code from other projects', 'Libraries Chimera runs on', 'Adding to this list'])} level={4} />
                </section>
            </Modal.Body>
        </Modal>
    );
}
