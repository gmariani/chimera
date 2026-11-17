/**
 * The source of each file that carries code from another project, as text, for the Credits list to take its notice
 * from (see credits.ts). The list has to be written out for the bundler; a test checks it's the same as the first
 * table in SOURCES.md, so a file added there and not here is caught. Loaded only with the Credits list.
 */
const sources = import.meta.glob<string>(
    ['../core/explode.ts', '../core/implode.test-util.ts', '../core/opl2.ts', '../formats/westwood/adl-player.ts', '../formats/westwood/adpcm.ts', '../formats/voc.ts', '../formats/swf/nellymoser.ts'],
    { query: '?raw', import: 'default', eager: true }
);

/** Each file's source by its path from the repository's root ("src/core/explode.ts"). */
export const PORTED_SOURCES: Record<string, string> = Object.fromEntries(Object.entries(sources).map(([path, text]) => [path.replace(/^\.\.\//, 'src/'), text]));
