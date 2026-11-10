import { Engine, workerTransport } from './client';

export { Stopped, type UiInspection, type UiParsed, type UiPreview } from './client';

/** The one parsing worker the page uses. */
export const engine = new Engine(() => workerTransport(new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })));
