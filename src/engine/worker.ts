import { serve } from './serve';

// Where every file is parsed, so the page can stop a parse that hangs by stopping this.
const handle = serve((message, transfer) => self.postMessage(message, { transfer: transfer ?? [] }));
self.onmessage = (event: MessageEvent) => handle(event.data);
