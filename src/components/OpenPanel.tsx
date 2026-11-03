import { useRef, useState, type DragEvent } from 'react';
import { Alert, Button } from 'react-bootstrap';
import { FORMATS } from '../formats';
import type { OpenFile } from '../lib/inspect';

/** Where a file comes in: dropped or picked from disk. Everything is read in the browser. */
export function OpenPanel({ onOpen }: { onOpen: (file: OpenFile) => void }) {
    const [dragging, setDragging] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [reading, setReading] = useState<string | null>(null);
    const input = useRef<HTMLInputElement>(null);

    const load = async (file: File | undefined) => {
        if (!file) return;
        setError(null);
        setReading(file.name);
        try {
            onOpen({ name: file.name, knownName: file.name, data: new Uint8Array(await file.arrayBuffer()) });
        } catch (e) {
            setError(`Couldn't read ${file.name}: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setReading(null);
        }
    };

    const drop = (event: DragEvent) => {
        event.preventDefault();
        setDragging(false);
        void load(event.dataTransfer.files[0]);
    };

    return (
        <main className="container-xxl bd-gutter mt-4 my-md-5 bd-content">
            <div
                className={`drop-zone ${dragging ? 'drop-zone--active' : ''}`}
                onDragOver={(e) => {
                    e.preventDefault();
                    setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={drop}
            >
                <h1 className="display-5 bd-title mb-2">What's inside this file?</h1>
                <p className="lead text-body-secondary mb-4">
                    Drop a file here to see how it's put together: every field, what it means, and the bytes behind it. Archives open up so you can look inside each file they hold, and pull any of it out.
                </p>

                {error && <Alert variant="warning">{error}</Alert>}

                <div className="drop-target" onClick={() => input.current?.click()} role="button" tabIndex={0} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}>
                    <i className="bi bi-file-earmark-arrow-down display-4 d-block mb-2" />
                    {reading ? <>Reading {reading}…</> : <>Drop a file, or click to choose one</>}
                </div>

                <div className="d-flex flex-wrap gap-2 mt-3 align-items-center">
                    <Button variant="primary" onClick={() => input.current?.click()}>
                        <i className="bi bi-folder2-open me-1" /> Open file…
                    </Button>
                    <span className="text-body-secondary small ms-auto">
                        <i className="bi bi-shield-lock me-1" />
                        Read in your browser. The file is never uploaded.
                    </span>
                </div>
                <input ref={input} type="file" hidden onChange={(e) => void load(e.target.files?.[0]).finally(() => (e.target.value = ''))} />
            </div>

            <div className="row g-4 mt-4">
                <div className="col-12">
                    <h3 className="h6">Understands</h3>
                    <ul className="list-inline small text-body-secondary mb-1">
                        {FORMATS.map((f) => (
                            <li key={f.id} className="list-inline-item format-chip">
                                {f.name} <span className="opacity-75">(.{f.extensions.slice(0, 3).join(', .')})</span>
                            </li>
                        ))}
                    </ul>
                    <p className="small text-body-secondary mb-0">Anything else opens in the hex view.</p>
                </div>
            </div>
        </main>
    );
}
