/** The site's navbar, in the same style as the Email Header Analyzer's. */
export function TopBar({ onNew }: { onNew?: () => void }) {
    return (
        <header className="navbar navbar-expand-lg bd-navbar">
            <nav className="container-xxl bd-gutter d-flex align-items-center">
                <a
                    href="./"
                    className="navbar-brand d-flex align-items-center gap-2 text-reset"
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
                {onNew && (
                    <button type="button" className="btn btn-outline-light btn-sm ms-auto" onClick={onNew}>
                        <i className="bi bi-folder2-open me-1" /> Open another
                    </button>
                )}
            </nav>
        </header>
    );
}
