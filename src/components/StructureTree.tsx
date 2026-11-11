import { useEffect, useRef, useState } from 'react';
import { hex } from '../core/bytes';
import type { Field } from '../core/types';
import { pathKey, type FieldPath } from '../lib/fields';

/** Long lists (a MIX index can have thousands of entries) show this many until asked for more. */
const PAGE = 200;

/** The file as a tree of labeled byte ranges. */
export function StructureTree({
    fields,
    selected,
    expanded,
    onSelect,
    onToggle,
    onHover,
}: {
    fields: Field[];
    selected: FieldPath | null;
    expanded: Set<string>;
    onSelect: (path: FieldPath) => void;
    onToggle: (path: FieldPath) => void;
    onHover: (field: Field | null) => void;
}) {
    const root = useRef<HTMLDivElement>(null);
    const selectedKey = selected ? pathKey(selected) : null;

    // Picking a byte in the hex view can select a field far down the list.
    useEffect(() => {
        if (selectedKey === null) return;
        root.current?.querySelector(`[data-path="${selectedKey}"]`)?.scrollIntoView({ block: 'nearest' });
    }, [selectedKey]);

    return (
        <div ref={root} className='structure-tree' role='tree' onMouseLeave={() => onHover(null)}>
            <Nodes fields={fields} path={[]} depth={0} selectedKey={selectedKey} expanded={expanded} onSelect={onSelect} onToggle={onToggle} onHover={onHover} />
        </div>
    );
}

function Nodes({
    fields,
    path,
    depth,
    selectedKey,
    expanded,
    onSelect,
    onToggle,
    onHover,
}: {
    fields: Field[];
    path: FieldPath;
    depth: number;
    selectedKey: string | null;
    expanded: Set<string>;
    onSelect: (path: FieldPath) => void;
    onToggle: (path: FieldPath) => void;
    onHover: (field: Field | null) => void;
}) {
    const [shown, setShown] = useState(PAGE);
    // Keep a selected field visible even past the page.
    const prefix = path.length ? `${pathKey(path)}.` : '';
    const selectedHere = selectedKey?.startsWith(prefix) ? Number(selectedKey.slice(prefix.length).split('.')[0]) : -1;
    const limit = Math.max(shown, selectedHere + 1);

    return (
        <>
            {fields.slice(0, limit).map((field, i) => {
                const here = [...path, i];
                const key = pathKey(here);
                const open = expanded.has(key);
                const hasChildren = !!field.children?.length;
                return (
                    <div key={i} role='treeitem' aria-expanded={hasChildren ? open : undefined} aria-selected={key === selectedKey}>
                        <div
                            data-path={key}
                            className={`tree-row ${key === selectedKey ? 'tree-row--selected' : ''}`}
                            style={{ paddingLeft: `${depth * 1.1 + 0.25}rem` }}
                            onClick={() => {
                                onSelect(here);
                                if (hasChildren && !open) onToggle(here);
                            }}
                            onMouseEnter={() => onHover(field)}>
                            <button
                                type='button'
                                className='tree-caret'
                                tabIndex={-1}
                                aria-label={open ? 'Collapse' : 'Expand'}
                                style={{ visibility: hasChildren ? 'visible' : 'hidden' }}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onToggle(here);
                                }}>
                                <i className={`bi ${open ? 'bi-caret-down-fill' : 'bi-caret-right-fill'}`} />
                            </button>
                            <span className='tree-name'>{field.name}</span>
                            {field.value !== undefined && <span className='tree-value'>{field.value}</span>}
                            <span className='tree-offset'>{hex(field.offset, 6)}</span>
                        </div>
                        {hasChildren && open && (
                            <Nodes fields={field.children!} path={here} depth={depth + 1} selectedKey={selectedKey} expanded={expanded} onSelect={onSelect} onToggle={onToggle} onHover={onHover} />
                        )}
                    </div>
                );
            })}
            {fields.length > limit && (
                <div style={{ paddingLeft: `${depth * 1.1 + 1.6}rem` }}>
                    <button type='button' className='btn btn-link btn-sm p-0' onClick={() => setShown((n) => n + PAGE * 5)}>
                        Show {Math.min(PAGE * 5, fields.length - limit)} more of {fields.length - limit}
                    </button>
                </div>
            )}
        </>
    );
}
