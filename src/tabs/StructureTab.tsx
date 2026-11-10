import { useMemo, useState } from 'react';
import { Button } from 'react-bootstrap';
import { bytesLabel, hex } from '../core/bytes';
import type { Field, Parsed } from '../core/types';
import { HexView } from '../components/HexView';
import { StructureTree } from '../components/StructureTree';
import { Muted } from '../components/ui';
import { download, safeName } from '../lib/download';
import { fieldAt, leaves, pathAt, pathKey, type FieldPath } from '../lib/fields';

/** The structure tree beside the hex dump: pick a field to see its bytes, or a byte to see its field. */
export function StructureTab({ data, parsed, fileName }: { data: Uint8Array; parsed: Pick<Parsed, 'fields' | 'overlays'>; fileName: string }) {
    const [selected, setSelected] = useState<FieldPath | null>(null);
    const [hovered, setHovered] = useState<Field | null>(null);
    // Open the top level when it's short enough to take in at a glance.
    const [expanded, setExpanded] = useState<Set<string>>(() => new Set(parsed.fields.length <= 6 ? parsed.fields.map((_, i) => String(i)) : []));
    const leafList = useMemo(() => leaves(parsed.fields), [parsed.fields]);
    const field = selected ? fieldAt(parsed.fields, selected) : null;

    const toggle = (path: FieldPath) =>
        setExpanded((set) => {
            const next = new Set(set);
            const key = pathKey(path);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });

    const pick = (offset: number) => {
        const path = pathAt(parsed.fields, offset);
        if (!path) return setSelected(null);
        setExpanded((set) => {
            const next = new Set(set);
            for (let i = 1; i < path.length; i++) next.add(pathKey(path.slice(0, i)));
            return next;
        });
        setSelected(path);
    };

    return (
        // Two cells of the frame: the fields on the left; what's picked, over its bytes, on the right.
        <div className="cell-row cell-row--structure">
            <div className="cell cell--tree">
                <StructureTree fields={parsed.fields} selected={selected} expanded={expanded} onSelect={setSelected} onToggle={toggle} onHover={setHovered} />
            </div>
            <div className="cell cell--bytes">
                <FieldDetails field={field} data={data} fileName={fileName} />
                <HexView data={data} leaves={leafList} overlays={parsed.overlays} selected={field} hovered={hovered} onPick={pick} />
            </div>
        </div>
    );
}

function FieldDetails({ field, data, fileName }: { field: Field | null; data: Uint8Array; fileName: string }) {
    if (!field) {
        return (
            <div className="field-details">
                <Muted>Pick a field on the left, or click a byte below, to see what it is.</Muted>
            </div>
        );
    }
    const end = field.offset + field.length;
    return (
        <div className="field-details">
            <div className="d-flex align-items-start gap-2">
                <div className="flex-grow-1">
                    <h3 className="h6 mb-1">{field.name}</h3>
                    {field.value !== undefined && <div className="field-value">{field.value}</div>}
                </div>
                {field.length > 0 && (
                    <Button
                        size="sm"
                        variant="outline-light"
                        title="Save just these bytes"
                        onClick={() => download(data.subarray(field.offset, end), safeName(`${fileName}.${hex(field.offset, 8)}-${field.name}.bin`))}
                    >
                        <i className="bi bi-download" />
                    </Button>
                )}
            </div>
            <div className="small text-body-secondary mt-1">
                Offset 0x{hex(field.offset, 8)} ({field.offset.toLocaleString('en-US')}) · {bytesLabel(field.length)}
                {field.length > 1 && ` · ends at 0x${hex(end - 1, 8)}`}
            </div>
            {field.note && <p className="small mb-0 mt-2">{field.note}</p>}
        </div>
    );
}
