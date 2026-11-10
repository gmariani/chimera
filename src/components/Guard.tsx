import { Component, type ReactNode } from 'react';
import { Alert } from 'react-bootstrap';

/**
 * Keeps a failure in one part of the page (a preview decoding a damaged or
 * crafted frame) from taking the whole page with it: that part says what went
 * wrong, and the rest stays usable.
 */
export class Guard extends Component<{ what: string; children: ReactNode }, { error: Error | null }> {
    override state: { error: Error | null } = { error: null };

    static getDerivedStateFromError(error: Error) {
        return { error };
    }

    override render() {
        const { error } = this.state;
        if (!error) return this.props.children;
        return (
            <Alert variant="danger" className="small">
                <i className="bi bi-shield-exclamation me-1" />
                The {this.props.what} stopped: {error.message} A damaged file can do this, and so can one made to break parsers. The structure and the hex view are still here.
            </Alert>
        );
    }
}
