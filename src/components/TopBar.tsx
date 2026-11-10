import { Badge } from 'react-bootstrap';
import { useLibrary } from '../lib/library';
import mark from '../images/chimera_48.png';
import markLarge from '../images/chimera_128.png';

/** The site's bar: the mark at the left, then cells divided by thin rules; the main action is a solid block at the right edge. */
export function TopBar({ onNew, onShowFiles }: { onNew?: () => void; onShowFiles: () => void }) {
    const { files } = useLibrary();
    return (
        <header className="bp-nav">
            <div className="bp-nav-inner">
                <a
                    href="./"
                    className="bp-nav-brand text-reset"
                    onClick={(e) => {
                        if (onNew) {
                            e.preventDefault();
                            onNew();
                        }
                    }}
                >
                    <span className="brand-mark">
                        <img src={mark} srcSet={`${mark} 1.5x, ${markLarge} 4x`} width={28} height={28} alt="" />
                    </span>
                    <span>.chimera</span>
                </a>
                <span className="flex-grow-1" />
                {files.length > 0 && (
                    <button type="button" className="bp-nav-cell" onClick={onShowFiles}>
                        <i className="bi bi-collection me-2" /> Files in use{' '}
                        <Badge bg="secondary" className="ms-2">
                            {files.length}
                        </Badge>
                    </button>
                )}
                {onNew && (
                    <button type="button" className="bp-nav-cell bp-nav-cell--solid" onClick={onNew}>
                        <i className="bi bi-folder2-open me-2" /> Open another
                    </button>
                )}
            </div>
        </header>
    );
}
