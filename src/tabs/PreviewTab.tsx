import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, ButtonGroup, Form, Spinner } from 'react-bootstrap';
import type { IndexedImage, Preview } from '../core/types';
import { CodeBlock, Muted, Tip } from '../components/ui';
import { download, safeName } from '../lib/download';
import { findPalettes } from '../lib/palette-sources';
import { usePalettes } from '../lib/palettes';
import { zip } from '../lib/zip';

const stem = (name: string) => name.replace(/\.[^.]+$/, '');

export function PreviewTab({ preview, fileName, names }: { preview: Preview; fileName: string; names: readonly string[] }) {
    switch (preview.kind) {
        case 'images':
            return <ImagesPreview frames={preview.frames} ownPalette={preview.palette} transparentIndex={preview.transparentIndex} shadowIndex={preview.shadowIndex} fileName={fileName} names={names} />;
        case 'palette':
            return <PalettePreview colors={preview.colors} fileName={fileName} />;
        case 'audio':
            return <AudioPreview preview={preview} fileName={fileName} />;
        case 'text':
            return <CodeBlock copy>{preview.text.length > 500_000 ? `${preview.text.slice(0, 500_000)}\n… (${preview.text.length - 500_000} more characters)` : preview.text}</CodeBlock>;
    }
}

/** How to turn palette indexes into colours. */
interface Paint {
    palette: Uint8Array;
    transparentIndex?: number;
    shadowIndex?: number;
}

/** Paints indexed pixels through a palette. */
function toImageData(image: IndexedImage, { palette, transparentIndex, shadowIndex }: Paint): ImageData {
    const out = new ImageData(image.width, image.height);
    const rgba = out.data;
    for (let i = 0; i < image.pixels.length; i++) {
        const p = image.pixels[i];
        if (p === transparentIndex) continue;
        if (p === shadowIndex) {
            rgba[i * 4 + 3] = 128;
            continue;
        }
        rgba[i * 4] = palette[p * 3];
        rgba[i * 4 + 1] = palette[p * 3 + 1];
        rgba[i * 4 + 2] = palette[p * 3 + 2];
        rgba[i * 4 + 3] = 255;
    }
    return out;
}

/** All frames in a grid, as one canvas. */
function sheet(frames: IndexedImage[], paint: Paint): HTMLCanvasElement {
    const columns = Math.ceil(Math.sqrt(frames.length));
    const w = Math.max(...frames.map((f) => f.width));
    const h = Math.max(...frames.map((f) => f.height));
    const canvas = document.createElement('canvas');
    canvas.width = columns * w;
    canvas.height = Math.ceil(frames.length / columns) * h;
    const ctx = canvas.getContext('2d')!;
    frames.forEach((f, i) => ctx.putImageData(toImageData(f, paint), (i % columns) * w, Math.floor(i / columns) * h));
    return canvas;
}

function frameCanvas(frame: IndexedImage, paint: Paint): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = frame.width;
    canvas.height = frame.height;
    canvas.getContext('2d')!.putImageData(toImageData(frame, paint), 0, 0);
    return canvas;
}

const png = (canvas: HTMLCanvasElement) => new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not make a PNG.'))), 'image/png'));

function ImagesPreview({
    frames,
    ownPalette,
    transparentIndex,
    shadowIndex,
    fileName,
    names,
}: {
    frames: IndexedImage[];
    ownPalette?: Uint8Array;
    transparentIndex?: number;
    shadowIndex?: number;
    fileName: string;
    names: readonly string[];
}) {
    const { palettes, current, select, add } = usePalettes();
    const [useOwn, setUseOwn] = useState(true);
    const palette = ownPalette && useOwn ? ownPalette : current.colors;
    const paint = useMemo(() => ({ palette, transparentIndex, shadowIndex }), [palette, transparentIndex, shadowIndex]);
    const [frame, setFrame] = useState(0);
    const [playing, setPlaying] = useState(false);
    const [view, setView] = useState<'frame' | 'sheet'>(frames.length > 1 ? 'sheet' : 'frame');
    const width = Math.max(...frames.map((f) => f.width));
    const [zoom, setZoom] = useState(width <= 64 ? 4 : width <= 160 ? 2 : 1);
    const [busy, setBusy] = useState(false);
    const [noPalettesIn, setNoPalettesIn] = useState<string | null>(null);
    const canvas = useRef<HTMLCanvasElement>(null);
    const paletteInput = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (!playing) return;
        const timer = setInterval(() => setFrame((f) => (f + 1) % frames.length), 1000 / 15);
        return () => clearInterval(timer);
    }, [playing, frames.length]);

    const sheetCanvas = useMemo(() => (view === 'sheet' ? sheet(frames, paint) : null), [view, frames, paint]);

    useEffect(() => {
        const el = canvas.current;
        if (!el) return;
        const source = view === 'sheet' ? sheetCanvas! : frameCanvas(frames[frame], paint);
        el.width = source.width;
        el.height = source.height;
        el.getContext('2d')!.drawImage(source, 0, 0);
    }, [view, sheetCanvas, frames, frame, paint]);

    const clickSheet = (e: React.MouseEvent<HTMLCanvasElement>) => {
        if (view !== 'sheet') return;
        const rect = e.currentTarget.getBoundingClientRect();
        const columns = Math.ceil(Math.sqrt(frames.length));
        const h = Math.max(...frames.map((f) => f.height));
        const x = Math.floor(((e.clientX - rect.left) / rect.width) * columns);
        const y = Math.floor(((e.clientY - rect.top) / rect.height) * e.currentTarget.height / h);
        const index = y * columns + x;
        if (index < frames.length) {
            setFrame(index);
            setView('frame');
        }
    };

    const saveAll = async () => {
        setBusy(true);
        try {
            const files = await Promise.all(frames.map(async (f, i) => ({ name: `${stem(fileName)}-${String(i).padStart(4, '0')}.png`, data: new Uint8Array(await (await png(frameCanvas(f, paint))).arrayBuffer()) })));
            download(zip(files), `${safeName(stem(fileName))}-frames.zip`);
        } finally {
            setBusy(false);
        }
    };

    const loadPalette = async (file: File | undefined) => {
        if (!file) return;
        const found = await findPalettes(file.name, new Uint8Array(await file.arrayBuffer()), names);
        add(found, true);
        setUseOwn(false);
        setNoPalettesIn(found.length ? null : file.name);
    };

    return (
        <div className="row g-4">
            <div className="col-lg-8">
                <div className="image-stage">
                    <canvas ref={canvas} className={`image-canvas ${view === 'sheet' ? 'image-canvas--sheet' : ''}`} style={{ width: `calc(${zoom} * var(--w))`, ['--w' as string]: `${(view === 'sheet' ? sheetCanvas?.width : frames[frame].width) ?? 0}px` }} onClick={clickSheet} />
                </div>
            </div>
            <div className="col-lg-4">
                {frames.length > 1 && (
                    <div className="mb-3">
                        <ButtonGroup size="sm" className="mb-2 d-flex">
                            <Button variant={view === 'sheet' ? 'primary' : 'outline-light'} onClick={() => setView('sheet')}>
                                All frames
                            </Button>
                            <Button variant={view === 'frame' ? 'primary' : 'outline-light'} onClick={() => setView('frame')}>
                                One frame
                            </Button>
                        </ButtonGroup>
                        {view === 'frame' && (
                            <div className="d-flex align-items-center gap-2">
                                <Button size="sm" variant="outline-light" onClick={() => setPlaying((p) => !p)} aria-label={playing ? 'Pause' : 'Play'}>
                                    <i className={`bi ${playing ? 'bi-pause-fill' : 'bi-play-fill'}`} />
                                </Button>
                                <Form.Range min={0} max={frames.length - 1} value={frame} onChange={(e) => setFrame(Number(e.target.value))} aria-label="Frame" />
                                <span className="text-nowrap small">
                                    {frame + 1} / {frames.length}
                                </span>
                            </div>
                        )}
                        {view === 'sheet' && (
                            <div className="small">
                                <Muted>Click a frame to look at it on its own.</Muted>
                            </div>
                        )}
                    </div>
                )}

                <Form.Group className="mb-3">
                    <Form.Label className="small text-body-secondary mb-1">Zoom</Form.Label>
                    <ButtonGroup size="sm" className="d-flex">
                        {[1, 2, 3, 4, 6].map((z) => (
                            <Button key={z} variant={zoom === z ? 'primary' : 'outline-light'} onClick={() => setZoom(z)}>
                                {z}×
                            </Button>
                        ))}
                    </ButtonGroup>
                </Form.Group>

                <Form.Group className="mb-3">
                    <Form.Label className="small text-body-secondary mb-1">Palette</Form.Label>
                    {ownPalette && <Form.Check type="switch" id="own-palette" label="Use the palette in this file" checked={useOwn} onChange={(e) => setUseOwn(e.target.checked)} className="mb-2" />}
                    {!(ownPalette && useOwn) && (
                        <Form.Select size="sm" value={current.id} onChange={(e) => select(e.target.value)}>
                            {palettes.map((p) => (
                                <option key={p.id} value={p.id}>
                                    {p.label}
                                </option>
                            ))}
                        </Form.Select>
                    )}
                    <div className="small mt-1">
                        <Tip label="A .pal file, or a MIX that has palettes in it (TEMPERAT.MIX, or Red Alert's REDALERT.MIX). Palettes in any archive you open are picked up too.">
                            <button type="button" className="btn btn-link btn-sm p-0" onClick={() => paletteInput.current?.click()}>
                                Load a palette…
                            </button>
                        </Tip>
                        {noPalettesIn && <div className="text-warning">No palettes found in {noPalettesIn}.</div>}
                    </div>
                    <input ref={paletteInput} type="file" hidden onChange={(e) => void loadPalette(e.target.files?.[0]).finally(() => (e.target.value = ''))} />
                </Form.Group>

                <div className="d-flex flex-wrap gap-2">
                    <Button size="sm" variant="outline-light" onClick={async () => download(await png(frameCanvas(frames[frame], paint)), `${safeName(stem(fileName))}${frames.length > 1 ? `-${String(frame).padStart(4, '0')}` : ''}.png`)}>
                        <i className="bi bi-image me-1" /> {frames.length > 1 ? 'This frame' : 'Save'} PNG
                    </Button>
                    {frames.length > 1 && (
                        <>
                            <Button size="sm" variant="outline-light" onClick={async () => download(await png(sheet(frames, paint)), `${safeName(stem(fileName))}-sheet.png`)}>
                                <i className="bi bi-grid-3x3 me-1" /> Sheet PNG
                            </Button>
                            <Button size="sm" variant="outline-light" disabled={busy} onClick={() => void saveAll()}>
                                {busy ? <Spinner animation="border" size="sm" className="me-1" /> : <i className="bi bi-file-zip me-1" />} Every frame
                            </Button>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

function PalettePreview({ colors, fileName }: { colors: Uint8Array; fileName: string }) {
    const { add, current } = usePalettes();
    const id = `opened:${fileName}:${colors.slice(0, 12).join(',')}`;
    return (
        <>
            <div className="palette-grid">
                {Array.from({ length: 256 }, (_, i) => {
                    const rgb = `#${[colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
                    return (
                        <Tip key={i} label={`${i} (0x${i.toString(16).toUpperCase().padStart(2, '0')})\n${rgb}`}>
                            <span className="palette-swatch" style={{ background: rgb }} />
                        </Tip>
                    );
                })}
            </div>
            <Button className="mt-3" variant={current.id === id ? 'success' : 'outline-light'} onClick={() => add([{ id, label: fileName, colors }], true)}>
                <i className={`bi ${current.id === id ? 'bi-check2' : 'bi-palette'} me-1`} /> {current.id === id ? 'Used for sprites' : 'Use for sprites'}
            </Button>
        </>
    );
}

function AudioPreview({ preview, fileName }: { preview: Extract<Preview, { kind: 'audio' }>; fileName: string }) {
    const url = useMemo(() => URL.createObjectURL(new Blob([preview.wav as Uint8Array<ArrayBuffer>], { type: 'audio/wav' })), [preview.wav]);
    useEffect(() => () => URL.revokeObjectURL(url), [url]);
    return (
        <div className="d-flex flex-wrap gap-3 align-items-center">
            <audio controls src={url} className="audio-player" />
            <Button variant="outline-light" onClick={() => download(preview.wav, `${safeName(stem(fileName))}.wav`, 'audio/wav')}>
                <i className="bi bi-file-earmark-music me-1" /> Save as WAV
            </Button>
            <Muted>
                {preview.seconds.toFixed(2)} s · {preview.sampleRate} Hz · {preview.bits}-bit {preview.channels === 2 ? 'stereo' : 'mono'}
            </Muted>
        </div>
    );
}
