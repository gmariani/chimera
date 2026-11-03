import { useEffect, useState } from 'react';
import { Inspector } from './components/Inspector';
import { OpenPanel } from './components/OpenPanel';
import { TopBar } from './components/TopBar';
import type { OpenFile } from './lib/inspect';
import { PaletteProvider } from './lib/palettes';

// File names the user loaded for MIX archives. Kept between visits; the files themselves never are.
const NAMES_KEY = 'chimera:names';

function storedNames(): string[] {
    try {
        return JSON.parse(localStorage.getItem(NAMES_KEY) ?? '[]');
    } catch {
        return [];
    }
}

function storeNames(names: string[]) {
    try {
        localStorage.setItem(NAMES_KEY, JSON.stringify(names));
    } catch {
        // Private mode or storage full: the names last until the tab closes.
    }
}

export function App() {
    /** The opened file, then each file opened from inside the one before. */
    const [trail, setTrail] = useState<OpenFile[]>([]);
    const [names, setNames] = useState<string[]>(storedNames);
    const current = trail.at(-1);

    useEffect(() => {
        document.title = current ? `${current.name} — .chimera` : '.chimera';
        window.scrollTo(0, 0);
    }, [current]);

    const updateNames = (next: string[]) => {
        setNames(next);
        storeNames(next);
    };

    return (
        <PaletteProvider>
            <TopBar onNew={current ? () => setTrail([]) : undefined} />
            {current ? (
                <main className="container-xxl bd-gutter mt-3 my-md-4 bd-content">
                    {trail.length > 1 && (
                        <nav aria-label="Where this file came from">
                            <ol className="breadcrumb mb-3">
                                {trail.map((file, i) => (
                                    <li key={i} className={`breadcrumb-item ${i === trail.length - 1 ? 'active' : ''}`} aria-current={i === trail.length - 1 ? 'page' : undefined}>
                                        {i === trail.length - 1 ? (
                                            file.name
                                        ) : (
                                            <button type="button" className="btn btn-link p-0 align-baseline" onClick={() => setTrail((t) => t.slice(0, i + 1))}>
                                                {file.name}
                                            </button>
                                        )}
                                    </li>
                                ))}
                            </ol>
                        </nav>
                    )}
                    <Inspector key={trail.length + current.name} file={current} names={names} onOpen={(file) => setTrail((t) => [...t, file])} onNames={updateNames} />
                </main>
            ) : (
                <OpenPanel onOpen={(file) => setTrail([file])} />
            )}
        </PaletteProvider>
    );
}
