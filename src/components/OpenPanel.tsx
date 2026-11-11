import { useRef, useState, type DragEvent } from 'react';
import { Alert, Button } from 'react-bootstrap';
import { FormatsCarousel } from './Formats';
import { SectionBar } from './ui';
import type { OpenFile } from '../lib/inspect';
import { useLibrary } from '../lib/library';

/** Where a file comes in: dropped or picked from disk. Everything is read in the browser. */
export function OpenPanel({ onOpen }: { onOpen: (file: OpenFile) => void }) {
    const [dragging, setDragging] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [reading, setReading] = useState<string | null>(null);
    const input = useRef<HTMLInputElement>(null);
    const library = useLibrary();

    /** Opens the first file; any others are there for it to use, like a map's theater archive. */
    const load = async (files: FileList | null | undefined) => {
        const [file, ...others] = files ?? [];
        if (!file) return;
        setError(null);
        setReading(file.name);
        try {
            for (const other of others) await library.add(other.name, new Uint8Array(await other.arrayBuffer()));
            onOpen({
                name: file.name,
                knownName: file.name,
                data: new Uint8Array(await file.arrayBuffer()),
            });
        } catch (e) {
            setError(`Couldn't read ${file.name}: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setReading(null);
        }
    };

    const drop = (event: DragEvent) => {
        event.preventDefault();
        setDragging(false);
        void load(event.dataTransfer.files);
    };

    return (
        <main className='frame'>
            <section className='frame-section'>
                <SectionBar index='01' title='Open'>
                    <span className='privacy-note'>
                        <i className='bi bi-shield-lock-fill' /> Read in your browser · never uploaded
                    </span>
                </SectionBar>
                <div
                    className={`drop-zone frame-pad ${dragging ? 'drop-zone--active' : ''}`}
                    onDragOver={(e) => {
                        e.preventDefault();
                        setDragging(true);
                    }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={drop}>
                    <h1 className='display-4 bd-title mb-3'>
                        What's inside this <em>file</em>?
                    </h1>
                    <p className='lead text-body-secondary mb-4'>
                        Drop a file here to see how it's put together: every field, what it means, and the bytes behind it. Archives open up so you can look inside each file they hold, and pull any of
                        it out.
                    </p>

                    {error && <Alert variant='warning'>{error}</Alert>}

                    <div className='drop-target' onClick={() => input.current?.click()} role='button' tabIndex={0} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}>
                        <i className='bi bi-file-earmark-arrow-down display-4 d-block mb-2' />
                        {reading ? <>Reading {reading}…</> : <>Drop a file, or click to choose one</>}
                    </div>

                    <div className='d-flex flex-wrap gap-2 mt-3 align-items-center'>
                        <Button variant='primary' onClick={() => input.current?.click()}>
                            <i className='bi bi-folder2-open me-1' /> Open file…
                        </Button>
                    </div>
                    <input ref={input} type='file' multiple hidden onChange={(e) => void load(e.target.files).finally(() => (e.target.value = ''))} />
                </div>
            </section>

            <section className='frame-section'>
                <FormatsCarousel />
            </section>

            <section className='frame-section'>
                <SectionBar index='03' title='Guide'></SectionBar>
                <div className='frame-pad'>
                    <h3 className='h3 mb-4'>How it works</h3>
                    <div className='tile-grid small guide'>
                        <div className='tile'>
                            <div className='tile-head'>
                                <h4>Open a file</h4>
                                <span>01</span>
                            </div>
                            <p>
                                Drop it above or choose it. It's recognized by what's in it, not by its name, and opens on a summary, a preview where there is one, and its structure: every field, with
                                its bytes highlighted in the hex view.
                            </p>
                        </div>
                        <div className='tile'>
                            <div className='tile-head'>
                                <h4>Look inside</h4>
                                <span>02</span>
                            </div>
                            <p>
                                An archive lists what it holds under Contents. Open any of those to look at it the same way, and use the trail at the top to go back. Save any file, or all of them as a
                                ZIP.
                            </p>
                        </div>
                        <div className='tile'>
                            <div className='tile-head'>
                                <h4>Alerts</h4>
                                <span>03</span>
                            </div>
                            <p>
                                Red means the file isn't what its name or first bytes say it is, or hides data past its end. Yellow is anything else the format's rules don't allow. When it could be
                                read another way, Open as shows it that way.
                            </p>
                        </div>
                        <div className='tile'>
                            <div className='tile-head'>
                                <h4>Other files</h4>
                                <span>04</span>
                            </div>
                            <p>
                                Some files need others: an archive's contents may draw on another archive. Drop them together and the first opens with the rest alongside it, or add them later under
                                Files in use. They stay for the session, and Open another keeps them.
                            </p>
                        </div>
                        <div className='tile'>
                            <div className='tile-head'>
                                <h4>Stop</h4>
                                <span>05</span>
                            </div>
                            <p>
                                Files are read in the background, so a broken or hostile one can't freeze the page. After a few seconds a Stop button appears, and after 30 seconds with no progress it
                                stops on its own. You still get the file's bytes, and it isn't read again until you reload.
                            </p>
                        </div>
                        <div className='tile'>
                            <div className='tile-head'>
                                <h4>Limits</h4>
                                <span>06</span>
                            </div>
                            <p>
                                Nothing is uploaded, so big files need memory in your browser (about twice their size). Anything it doesn't recognize opens in the hex view only. Some formats aren't
                                fully documented, so some of their fields are unnamed.
                            </p>
                        </div>
                    </div>
                </div>
            </section>
        </main>
    );
}
