import { useMemo, useState } from 'react';
import { Button, ButtonGroup, Form, Table } from 'react-bootstrap';
import type { TableColumn, TableRow } from '../core/types';
import { Muted } from '../components/ui';

const PAGE = 500;

/**
 * Rows of values in groups: pick a group, filter, sort by any column. A cell
 * that names files opens the first one found among the files in use.
 */
export function TablePreview({ columns, groups, rows, onOpenName }: { columns: TableColumn[]; groups: string[]; rows: TableRow[]; onOpenName?: (names: string[]) => boolean }) {
    const [group, setGroup] = useState('');
    const [filter, setFilter] = useState('');
    const [sort, setSort] = useState<{ key: string; descending: boolean } | null>(null);
    const [shown, setShown] = useState(PAGE);
    const [missing, setMissing] = useState<string | null>(null);

    const visible = useMemo(() => {
        const needle = filter.trim().toLowerCase();
        const list = rows.filter((r) => (!group || r.group === group) && (!needle || Object.values(r.cells).some((v) => v.toLowerCase().includes(needle))));
        if (sort) {
            const column = columns.find((c) => c.key === sort.key);
            list.sort((a, b) => {
                const [x, y] = [a.cells[sort.key] ?? '', b.cells[sort.key] ?? ''];
                const order = column?.numeric ? (Number(x) || 0) - (Number(y) || 0) : x.localeCompare(y);
                return sort.descending ? -order : order;
            });
        }
        return list;
    }, [rows, columns, group, filter, sort]);

    const open = (names: string[]) => {
        if (onOpenName?.(names)) setMissing(null);
        else setMissing(names[0]);
    };

    return (
        <div>
            <div className="d-flex flex-wrap gap-2 align-items-center mb-2">
                {groups.length > 1 && (
                    <ButtonGroup size="sm">
                        <Button variant={group ? 'outline-light' : 'primary'} onClick={() => setGroup('')}>
                            All {rows.length}
                        </Button>
                        {groups.map((g) => (
                            <Button key={g} variant={group === g ? 'primary' : 'outline-light'} onClick={() => setGroup(g)}>
                                {g} {rows.filter((r) => r.group === g).length}
                            </Button>
                        ))}
                    </ButtonGroup>
                )}
                <Form.Control size="sm" className="ms-auto" style={{ maxWidth: '16rem' }} placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
            {missing && (
                <div className="small text-warning mb-2">
                    {missing} isn't in the files in use. Add the archive that has it (Files in use, top right) and try again.
                </div>
            )}
            <div className="table-responsive">
                <Table size="sm" hover className="small contents-table">
                    <thead>
                        <tr>
                            {columns.map((c) => (
                                <th
                                    key={c.key}
                                    className={`sortable ${c.numeric ? 'text-end' : ''}`}
                                    onClick={() => setSort((s) => ({ key: c.key, descending: s?.key === c.key ? !s.descending : false }))}
                                    aria-sort={sort?.key === c.key ? (sort.descending ? 'descending' : 'ascending') : undefined}
                                >
                                    {c.label}
                                    {sort?.key === c.key && <i className={`bi ms-1 ${sort.descending ? 'bi-caret-down-fill' : 'bi-caret-up-fill'}`} />}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {visible.slice(0, shown).map((r, i) => (
                            <tr key={`${r.group}:${r.cells[columns[0].key]}:${i}`}>
                                {columns.map((c) => {
                                    const value = r.cells[c.key] ?? '';
                                    const files = r.files?.[c.key];
                                    return (
                                        <td key={c.key} className={c.numeric ? 'text-end font-monospace' : c.key === 'id' ? 'font-monospace' : ''}>
                                            {files?.length && value ? (
                                                <button type="button" className={`btn btn-link btn-sm p-0 text-start font-monospace ${value.includes('(not in') ? 'link-secondary' : ''}`} onClick={() => open(files)}>
                                                    {value}
                                                </button>
                                            ) : (
                                                value
                                            )}
                                        </td>
                                    );
                                })}
                            </tr>
                        ))}
                    </tbody>
                </Table>
            </div>
            {visible.length > shown && (
                <Button size="sm" variant="outline-light" onClick={() => setShown((n) => n + PAGE)}>
                    Show {Math.min(PAGE, visible.length - shown)} more of {visible.length - shown}
                </Button>
            )}
            {!visible.length && <Muted>Nothing matches.</Muted>}
        </div>
    );
}
