import { lazy, Suspense, useState } from 'react';

// The license texts and sources are only loaded when someone asks for them.
const CreditsModal = lazy(() => import('./Credits').then((m) => ({ default: m.CreditsModal })));

/** The bar at the foot of every page, in the frame: who made it, when this copy was built, and the credits. */
export function Footer() {
    const [credits, setCredits] = useState(false);
    return (
        <footer className='frame frame-footer'>
            <span>© {__BUILD_YEAR__} Gabriel Mariani</span>
            <button type='button' className='btn btn-link p-0 footer-link' onClick={() => setCredits(true)}>
                Credits and licenses
            </button>
            <span>Last built on: {__BUILD_DATE__}</span>
            {credits && (
                <Suspense fallback={null}>
                    <CreditsModal show={credits} onHide={() => setCredits(false)} />
                </Suspense>
            )}
        </footer>
    );
}
