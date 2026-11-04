import { Badge } from 'react-bootstrap';
import { useLibrary } from '../lib/library';

/** The site's navbar, in the same style as the Email Header Analyzer's. */
export function TopBar({ onNew, onShowFiles }: { onNew?: () => void; onShowFiles: () => void }) {
    const { files } = useLibrary();
    return (
        <header className="navbar navbar-expand-lg bd-navbar">
            <nav className="container-xxl bd-gutter d-flex align-items-center gap-2">
                <a
                    href="./"
                    className="navbar-brand d-flex align-items-center gap-2 text-reset me-auto"
                    onClick={(e) => {
                        if (onNew) {
                            e.preventDefault();
                            onNew();
                        }
                    }}
                >
                    <i className="bi bi-file-earmark-binary" />
                    <span>.chimera</span>
                </a>
                {files.length > 0 && (
                    <button type="button" className="btn btn-outline-light btn-sm" onClick={onShowFiles}>
                        <i className="bi bi-collection me-1" /> Files in use <Badge bg="secondary">{files.length}</Badge>
                    </button>
                )}
                {onNew && (
                    <button type="button" className="btn btn-outline-light btn-sm" onClick={onNew}>
                        <i className="bi bi-folder2-open me-1" /> Open another
                    </button>
                )}
            </nav>
        </header>
    );
}
