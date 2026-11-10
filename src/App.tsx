import { useEffect, useRef, useState } from 'react';
import { EngineNotices } from './components/EngineNotices';
import { FilesPanel } from './components/FilesPanel';
import { Inspector } from './components/Inspector';
import { OpenPanel } from './components/OpenPanel';
import { TopBar } from './components/TopBar';
import type { OpenFile } from './lib/inspect';
import { LibraryProvider } from './lib/library';
import { PaletteProvider } from './lib/palettes';
import type { ViewMemory } from './lib/view-memory';

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
    const [showFiles, setShowFiles] = useState(false);
    const current = trail.at(-1);
    // Each opened file's page settings, so going back to it restores them.
    const memories = useRef(new WeakMap<OpenFile, ViewMemory>());
    const memoryOf = (file: OpenFile) => {
        if (!memories.current.has(file)) memories.current.set(file, new Map());
        return memories.current.get(file)!;
    };

    useEffect(() => {
        document.title = current ? `${current.name} — .chimera` : '.chimera';
        window.scrollTo(0, 0);
    }, [current]);

    const updateNames = (next: string[]) => {
        setNames(next);
        storeNames(next);
    };

    return (
        <LibraryProvider names={names}>
            <PaletteProvider>
                <TopBar onNew={current ? () => setTrail([]) : undefined} onShowFiles={() => setShowFiles(true)} />
                <FilesPanel show={showFiles} onHide={() => setShowFiles(false)} />
                <EngineNotices />
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
                        <Inspector key={`${trail.length}${current.name}${current.as ?? ''}`} file={current} root={trail.length === 1} near={trail.length > 1 ? trail.slice(0, -1).map((f) => f.name).join(' › ') : undefined} names={names} memory={memoryOf(current)} onShowFiles={() => setShowFiles(true)} onOpen={(file) => setTrail((t) => [...t, file])} onOpenAs={(as) => setTrail((t) => [...t.slice(0, -1), { ...t[t.length - 1], as }])} onNames={updateNames} />
                    </main>
                ) : (
                    <OpenPanel onOpen={(file) => setTrail([file])} />
                )}
            </PaletteProvider>
        </LibraryProvider>
    );
}
