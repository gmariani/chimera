import { useEffect, useState } from 'react';
import { Alert } from 'react-bootstrap';
import { engine } from '../engine';

/**
 * Says when the parsing worker had to be stopped while doing something other
 * than reading the file on screen (adding a file to the session, looking for
 * palettes): a file opened in the view says so itself.
 */
export function EngineNotices() {
    const [notices, setNotices] = useState<{ id: number; text: string }[]>([]);
    useEffect(
        () =>
            engine.on((e) => {
                if (e.kind !== 'stopped' || e.op === 'inspect') return;
                setNotices((n) => [...n, { id: Date.now() + Math.random(), text: `${e.what} was stopped. ${e.reason}` }]);
            }),
        [],
    );
    if (!notices.length) return null;
    return (
        <div className="container-xxl bd-gutter mt-3">
            {notices.map((n) => (
                <Alert key={n.id} variant="danger" className="small py-2" dismissible onClose={() => setNotices((all) => all.filter((x) => x.id !== n.id))}>
                    <i className="bi bi-shield-exclamation me-1" />
                    {n.text}
                </Alert>
            ))}
        </div>
    );
}
