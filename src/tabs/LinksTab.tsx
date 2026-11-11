import { Table } from 'react-bootstrap';
import type { Link } from '../core/types';
import { AddFilesButton } from '../components/AddFiles';
import { Muted } from '../components/ui';

/** Lists longer than this start folded. */
const FOLD = 12;

/**
 * The other files this one drew on, grouped by the archive they came from,
 * and those it looked for but couldn't find, with a way to add them.
 */
export function LinksTab({ links, onShowFiles }: { links: Link[]; onShowFiles: () => void }) {
    const missing = links.filter((l) => !l.source);
    const bySource = new Map<string, Link[]>();
    for (const l of links) if (l.source) bySource.set(l.source, [...(bySource.get(l.source) ?? []), l]);

    return (
        <div className='links'>
            <p className='small text-body-secondary'>
                To show this file, the app looked up other files by name in{' '}
                <button type='button' className='btn btn-link btn-sm p-0 align-baseline' onClick={onShowFiles}>
                    the files in use
                </button>
                : the ones you've opened or added this session, and the archives inside them. Whichever has the name is used; nothing is changed.
            </p>

            {missing.length > 0 && (
                <section className='mb-4'>
                    <h3 className='h6 mb-2'>Not found ({missing.length})</h3>
                    <p className='small mb-2'>These would add to what's shown. Add the archive that holds them (any archive will do, they're found by name) and this file updates.</p>
                    <div className='mb-2'>
                        <AddFilesButton variant='primary' />
                    </div>
                    <LinkTable links={missing} />
                </section>
            )}

            {bySource.size > 0 && (
                <section>
                    <h3 className='h6 mb-2'>Used ({links.length - missing.length})</h3>
                    {[...bySource].map(([source, list]) => (
                        <details key={source} className='mb-2' open={list.length <= FOLD}>
                            <summary>
                                <span className='font-monospace'>{source}</span>{' '}
                                <Muted>
                                    · {list.length} file{list.length === 1 ? '' : 's'}: {[...new Set(list.map((l) => l.role.replace(/ \(.*\)$/, '')))].join(', ').toLowerCase()}
                                </Muted>
                            </summary>
                            <LinkTable links={list} />
                        </details>
                    ))}
                </section>
            )}
        </div>
    );
}

function LinkTable({ links }: { links: Link[] }) {
    return (
        <Table size='sm' className='small mb-2 links-table'>
            <thead>
                <tr>
                    <th>File</th>
                    <th>For</th>
                </tr>
            </thead>
            <tbody>
                {links.map((l) => (
                    <tr key={l.name}>
                        <td className='font-monospace'>{l.name}</td>
                        <td>{l.role}</td>
                    </tr>
                ))}
            </tbody>
        </Table>
    );
}
