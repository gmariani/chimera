import { useEffect, useRef, useState } from 'react';
import { Button, ButtonGroup } from 'react-bootstrap';
import type { DialogControl, Preview } from '../core/types';

type DialogPreviewData = Extract<Preview, { kind: 'dialog' }>;

const ZOOMS = [1, 1.5, 2] as const;

/**
 * A dialog drawn as a blueprint of itself: its frame and title bar, and each control where the program puts it, in thin
 * lines. Dialog units become pixels by the dialog's font, as Windows does; controls the program shows only later are
 * drawn faint and dashed. Pointing at a control says what it is.
 */
export function DialogPreview({ preview }: { preview: DialogPreviewData }) {
    const [zoom, setZoom] = useState<number>(1.5);
    const [ux, uy] = preview.units;
    const px = (v: number, unit: number) => Math.round(v * unit * zoom);
    // The font's size in pixels at 96 dots an inch; the system font's, when the dialog names none.
    const fontSize = (preview.font.size ? (preview.font.size * 4) / 3 : 12) * zoom;
    const font = `${fontSize}px ${preview.font.name ? `'${preview.font.name}', ` : ''}Tahoma, 'Lato', Arial, sans-serif`;

    return (
        <div className='cell-row cell-row--boxed'>
            <div className='cell cell--stage'>
                <div className='dialog-stage'>
                    <div className='dialog-window' style={{ font }}>
                        {preview.caption && <div className='dialog-caption'>{preview.title || ' '}</div>}
                        <div className='dialog-client' style={{ width: px(preview.width, ux), height: px(preview.height, uy) }}>
                            {preview.controls.map((c, i) => (
                                <Control key={i} control={c} style={{ left: px(c.x, ux), top: px(c.y, uy), width: px(c.width, ux), height: px(c.height, uy) }} zoom={zoom} />
                            ))}
                        </div>
                    </div>
                </div>
            </div>
            <div className='cell cell--side'>
                <ButtonGroup size='sm' className='mb-3'>
                    {ZOOMS.map((z) => (
                        <Button key={z} variant='outline-light' active={zoom === z} onClick={() => setZoom(z)}>
                            {z}×
                        </Button>
                    ))}
                </ButtonGroup>
                <p className='small text-body-secondary mb-0'>
                    {preview.width} × {preview.height} dialog units, {preview.controls.length} control{preview.controls.length === 1 ? '' : 's'}. Drawn at the sizes{' '}
                    {preview.font.name || 'the system font'} has at 96 dots an inch; Windows measures the font itself, so it may differ a little. Faint, dashed controls are hidden until the program
                    shows them.
                </p>
            </div>
        </div>
    );
}

/** A control's text, with the letter after & underlined (its keyboard shortcut) and && as a plain &. */
function Label({ text }: { text: string }) {
    const parts = text.split(/(&&|&.)/s);
    return <>{parts.map((p, i) => (p === '&&' ? '&' : p.length === 2 && p[0] === '&' ? <u key={i}>{p[1]}</u> : p))}</>;
}

function Control({ control: c, style, zoom }: { control: DialogControl; style: React.CSSProperties; zoom: number }) {
    const about = `${c.className}, ID ${c.id}${c.text ? `: ${c.text.replace(/&(.)/g, '$1')}` : ''}${c.hidden ? ' (hidden at first)' : ''}${c.disabled ? ' (disabled)' : ''}`;
    const className = `dialog-control dialog-control--${c.kind}${c.hidden ? ' is-hidden' : ''}${c.disabled ? ' is-disabled' : ''}${c.align ? ` is-${c.align}` : ''}`;
    let inner: React.ReactNode;
    switch (c.kind) {
        case 'checkbox':
        case 'radio':
            inner = (
                <>
                    <span className='dialog-mark' />
                    <span className='dialog-text'>
                        <Label text={c.text} />
                    </span>
                </>
            );
            break;
        case 'group':
            inner = c.text ? (
                <span className='dialog-legend'>
                    <Label text={c.text} />
                </span>
            ) : null;
            break;
        case 'image':
            inner = c.picture ? <Picture picture={c.picture} zoom={zoom} /> : <span className='dialog-text'>{c.text}</span>;
            break;
        case 'combo':
            inner = (
                <>
                    <span className='dialog-text'>{c.text}</span>
                    <span className='dialog-arrow'>▾</span>
                </>
            );
            break;
        case 'custom':
            inner = <span className='dialog-text dialog-class'>{c.text || c.className}</span>;
            break;
        case 'rect':
        case 'frame':
        case 'line':
        case 'scrollbar':
            inner = null;
            break;
        default:
            inner = (
                <span className='dialog-text'>
                    <Label text={c.text} />
                </span>
            );
    }
    return (
        <div className={className} style={style} title={about}>
            {inner}
        </div>
    );
}

/** An icon or bitmap the dialog shows, at its own size in pixels. */
function Picture({ picture, zoom }: { picture: { width: number; height: number; rgba: Uint8Array }; zoom: number }) {
    const canvas = useRef<HTMLCanvasElement>(null);
    useEffect(() => {
        const el = canvas.current;
        if (!el) return;
        el.width = picture.width;
        el.height = picture.height;
        el.getContext('2d')!.putImageData(
            new ImageData(new Uint8ClampedArray(picture.rgba.buffer as ArrayBuffer, picture.rgba.byteOffset, picture.width * picture.height * 4), picture.width, picture.height),
            0,
            0
        );
    }, [picture]);
    return <canvas ref={canvas} className='dialog-picture' style={{ width: picture.width * zoom, height: picture.height * zoom }} />;
}
