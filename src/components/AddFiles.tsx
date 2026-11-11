import { useRef, useState } from 'react';
import { Button, Spinner } from 'react-bootstrap';
import { useLibrary } from '../lib/library';

/** Adds files to the session for other files to use, without opening them; says how many files they brought. */
export function AddFilesButton({ label = 'Add files…', variant = 'outline-light' }: { label?: string; variant?: string }) {
    const { add } = useLibrary();
    const input = useRef<HTMLInputElement>(null);
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<string | null>(null);

    const load = async (files: FileList | null) => {
        if (!files?.length) return;
        setBusy(true);
        try {
            let added = 0;
            for (const f of files) added += await add(f.name, new Uint8Array(await f.arrayBuffer()));
            setResult(added ? `Added ${added.toLocaleString('en-US')} file${added === 1 ? '' : 's'}.` : 'Already in use.');
        } finally {
            setBusy(false);
        }
    };

    return (
        <span className='d-inline-flex align-items-center gap-2'>
            <Button size='sm' variant={variant} disabled={busy} onClick={() => input.current?.click()}>
                {busy ? <Spinner animation='border' size='sm' className='me-1' /> : <i className='bi bi-plus-lg me-1' />} {label}
            </Button>
            {result && <span className='small text-body-secondary'>{result}</span>}
            <input ref={input} type='file' multiple hidden onChange={(e) => void load(e.target.files).finally(() => (e.target.value = ''))} />
        </span>
    );
}
