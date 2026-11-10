/** The bar at the foot of every page, in the frame: who made it, and when this copy was built. */
export function Footer() {
    return (
        <footer className="frame frame-footer">
            <span>© {__BUILD_YEAR__} Gabriel Mariani</span>
            <span>Last built on: {__BUILD_DATE__}</span>
        </footer>
    );
}
