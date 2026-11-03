import { useState, type ReactElement, type ReactNode } from 'react';
import { OverlayTrigger, Tooltip } from 'react-bootstrap';

export function Tip({ label, children }: { label: ReactNode; children: ReactElement }) {
    if (label === null || label === undefined || label === '') return children;
    return (
        <OverlayTrigger placement="top" overlay={<Tooltip className="tip-multiline">{label}</Tooltip>}>
            {children}
        </OverlayTrigger>
    );
}

export function CopyButton({ text }: { text: string }) {
    const [copied, setCopied] = useState(false);
    return (
        <button
            type="button"
            className="btn btn-clipboard"
            title={copied ? 'Copied!' : 'Copy to clipboard'}
            onClick={() => {
                navigator.clipboard.writeText(text).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1200);
                });
            }}
        >
            <i className={`bi ${copied ? 'bi-check2' : 'bi-clipboard'}`} />
        </button>
    );
}

/** Label/value rows in the email analyzer's two-column layout. */
export function Dl({ rows, labelCols = 3, className = '' }: { rows: [ReactNode, ReactNode][]; labelCols?: number; className?: string }) {
    return (
        <dl className={`row ${className}`}>
            {rows.map(([label, value], i) => (
                <DlRow key={i} label={label} labelCols={labelCols}>
                    {value}
                </DlRow>
            ))}
        </dl>
    );
}

function DlRow({ label, children, labelCols }: { label: ReactNode; children: ReactNode; labelCols: number }) {
    return (
        <>
            <dt className={`col-sm-${labelCols}`}>{label}</dt>
            <dd className={`col-sm-${12 - labelCols}`}>{children}</dd>
        </>
    );
}

export function SectionTitle({ children, className = '' }: { children: ReactNode; className?: string }) {
    return <h2 className={`display-6 bd-group-title ${className}`}>{children}</h2>;
}

export function CodeBlock({ children, copy }: { children: string; copy?: boolean }) {
    return (
        <div className="bd-code-snippet">
            <div className="highlight">
                {copy && (
                    <div className="code-copy">
                        <CopyButton text={children} />
                    </div>
                )}
                <pre>{children}</pre>
            </div>
        </div>
    );
}

export function Muted({ children }: { children: ReactNode }) {
    return <span className="text-body-secondary">{children}</span>;
}
