import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { Button, ButtonGroup, Form, Spinner } from 'react-bootstrap';
import type { AudioClip, IndexedImage, VideoFrame } from '../core/types';
import { engine, type UiPreview } from '../engine';
import { CodeBlock, Muted, SectionTitle, Tip } from '../components/ui';
import { download, safeName } from '../lib/download';
import { PaletteSelect, usePalettes } from '../lib/palettes';
import { zip } from '../lib/zip';
import { TablePreview } from './TablePreview';
import { VoxelViewer } from './VoxelViewer';
import { TeamColorSelect, useTeamColor } from '../components/TeamColor';
import { maxOf } from '../core/math';

const stem = (name: string) => name.replace(/\.[^.]+$/, '');

/**
 * The other way of drawing a preview (its switch off), asked of the parsing
 * worker the first time it's wanted, then kept.
 */
function useOff<T>(toggle: { off(): Promise<T> } | undefined, on: boolean): { other: T | null; waiting: boolean; error: string | null } {
    const [got, setGot] = useState<{ toggle: unknown; other: T | null; error: string | null } | null>(null);
    const asked = useRef<unknown>(null);
    useEffect(() => {
        if (on || !toggle || asked.current === toggle) return;
        asked.current = toggle;
        toggle.off().then(
            (other) => setGot({ toggle, other, error: null }),
            (e: unknown) => setGot({ toggle, other: null, error: e instanceof Error ? e.message : String(e) })
        );
    }, [on, toggle]);
    const mine = got?.toggle === toggle ? got : null;
    return { other: mine?.other ?? null, waiting: !on && !!toggle && !mine, error: mine?.error ?? null };
}

/** A note beside a preview's switch while the other view is on its way, or why it couldn't be drawn. */
function OffNote({ waiting, error }: { waiting: boolean; error: string | null }) {
    if (waiting)
        return (
            <p className='small mb-3'>
                <Spinner animation='border' size='sm' className='me-1' /> Drawing…
            </p>
        );
    if (error) return <p className='small text-danger mb-3'>Couldn't draw it that way: {error}</p>;
    return null;
}

export function PreviewTab({
    preview,
    fileName,
    onOpenName,
}: {
    preview: UiPreview;
    fileName: string;
    /** Opens the first of these files found among the files in use; false if none is. */ onOpenName?: (names: string[]) => Promise<boolean>;
}) {
    switch (preview.kind) {
        case 'images':
            return (
                <ImagesPreview
                    frames={preview.frames}
                    ownPalette={preview.palette}
                    transparentIndex={preview.transparentIndex}
                    shadowIndex={preview.shadowIndex}
                    columns={preview.columns}
                    legend={preview.legend}
                    remap={preview.remap}
                    toggle={preview.toggle}
                    fileName={fileName}
                />
            );
        case 'palette':
            return <PalettePreview colors={preview.colors} fileName={fileName} />;
        case 'picture':
            return <PicturePreview width={preview.width} height={preview.height} rgba={preview.rgba} toggle={preview.toggle} fileName={fileName} />;
        case 'audio':
            return <AudioPreview clip={preview} fileName={fileName} />;
        case 'video':
            return <VideoPreview preview={preview} fileName={fileName} />;
        case 'table':
            return <TablePreview columns={preview.columns} groups={preview.groups} rows={preview.rows} onOpenName={onOpenName} />;
        case 'voxels':
            return <VoxelViewer parts={preview.parts} frameCount={preview.frameCount} ownPalette={preview.palette} remap={preview.remap} fileName={fileName} />;
        case 'text':
            return <CodeBlock copy>{preview.text.length > 500_000 ? `${preview.text.slice(0, 500_000)}\n… (${preview.text.length - 500_000} more characters)` : preview.text}</CodeBlock>;
        case 'stack':
            return (
                <>
                    {preview.items.map((item, i) => (
                        <section key={i} className='mb-5'>
                            <SectionTitle className='mb-3'>{item.title}</SectionTitle>
                            <PreviewTab preview={item.preview} fileName={fileName} onOpenName={onOpenName} />
                        </section>
                    ))}
                </>
            );
    }
}

/** How to turn palette indexes into colors. */
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

/** How many frames to a row on a sheet: as given, or as square as possible. */
const sheetColumns = (frames: IndexedImage[], columns?: number) => columns ?? Math.ceil(Math.sqrt(frames.length));

/** How big a picture is drawn: fitted to the stage, or a whole multiple of its pixels. */
type Zoom = number | 'fit';
const ZOOMS: Zoom[] = ['fit', 1, 2, 3, 4, 6];

/** Big pictures (whole maps) start fitted to the page; small ones (a unit's sprite) enlarged. */
const initialZoom = (width: number): Zoom => (width > 900 ? 'fit' : width <= 64 ? 4 : width <= 160 ? 2 : 1);

/** Fit shows the whole picture at 1:1, or smaller if that's what fits the stage (its height less its padding); it never enlarges. */
const zoomStyle = (zoom: Zoom, width: number, height: number): React.CSSProperties =>
    zoom === 'fit'
        ? { width: `min(${width}px, 100%${height ? `, calc((var(--stage-height) - 2rem) * ${width / height})` : ''})` }
        : { width: `calc(${zoom} * var(--w))`, ['--w' as string]: `${width}px` };

/** The same zoom choices for every picture: maps of any game, sprites, tiles. */
function ZoomButtons({ zoom, onChange }: { zoom: Zoom; onChange: (zoom: Zoom) => void }) {
    return (
        <Form.Group className='mb-3'>
            <Form.Label className='small text-body-secondary mb-1'>Zoom</Form.Label>
            <ButtonGroup size='sm' className='d-flex'>
                {ZOOMS.map((z) => (
                    <Button key={z} variant={zoom === z ? 'primary' : 'outline-light'} onClick={() => onChange(z)}>
                        {z === 'fit' ? 'Fit' : `${z}×`}
                    </Button>
                ))}
            </ButtonGroup>
        </Form.Group>
    );
}

/** All frames in a grid, as one canvas. */
function sheet(frames: IndexedImage[], paint: Paint, columnsWanted?: number): HTMLCanvasElement {
    const columns = sheetColumns(frames, columnsWanted);
    const w = maxOf(frames.map((f) => f.width));
    const h = maxOf(frames.map((f) => f.height));
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
    frames: framesOn,
    ownPalette,
    transparentIndex,
    shadowIndex,
    columns,
    legend,
    remap,
    toggle,
    fileName,
}: {
    frames: IndexedImage[];
    toggle?: { label: string; off(): Promise<IndexedImage[]> };
    ownPalette?: Uint8Array;
    transparentIndex?: number;
    shadowIndex?: number;
    columns?: number;
    legend?: { label: string; index: number }[];
    remap?: [number, number];
    fileName: string;
}) {
    // With the switch off, the pictures without what it draws (made the first time, then kept).
    const [on, setOn] = useState(true);
    const off = useOff(toggle, on);
    const frames = on || !toggle || !off.other ? framesOn : off.other;
    const { current, add } = usePalettes();
    const [useOwn, setUseOwn] = useState(true);
    const team = useTeamColor(ownPalette && useOwn ? ownPalette : current.colors, remap);
    const palette = team.palette;
    const paint = useMemo(() => ({ palette, transparentIndex, shadowIndex }), [palette, transparentIndex, shadowIndex]);
    const [frame, setFrame] = useState(0);
    const [playing, setPlaying] = useState(false);
    const [view, setView] = useState<'frame' | 'sheet'>(frames.length > 1 ? 'sheet' : 'frame');
    const width = maxOf(frames.map((f) => f.width));
    const [zoom, setZoom] = useState<Zoom>(initialZoom(width));
    const pan = useDragPan<HTMLDivElement>();
    const [busy, setBusy] = useState(false);
    const [noPalettesIn, setNoPalettesIn] = useState<string | null>(null);
    const canvas = useRef<HTMLCanvasElement>(null);
    const paletteInput = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (!playing) return;
        const timer = setInterval(() => setFrame((f) => (f + 1) % frames.length), 1000 / 15);
        return () => clearInterval(timer);
    }, [playing, frames.length]);

    const sheetCanvas = useMemo(() => (view === 'sheet' ? sheet(frames, paint, columns) : null), [view, frames, paint, columns]);

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
        const across = sheetColumns(frames, columns);
        const h = maxOf(frames.map((f) => f.height));
        const x = Math.floor(((e.clientX - rect.left) / rect.width) * across);
        const y = Math.floor((((e.clientY - rect.top) / rect.height) * e.currentTarget.height) / h);
        const index = y * across + x;
        if (index < frames.length) {
            setFrame(index);
            setView('frame');
        }
    };

    const saveAll = async () => {
        setBusy(true);
        try {
            const files = await Promise.all(
                frames.map(async (f, i) => ({ name: `${stem(fileName)}-${String(i).padStart(4, '0')}.png`, data: new Uint8Array(await (await png(frameCanvas(f, paint))).arrayBuffer()) }))
            );
            download(zip(files), `${safeName(stem(fileName))}-frames.zip`);
        } finally {
            setBusy(false);
        }
    };

    const loadPalette = async (file: File | undefined) => {
        if (!file) return;
        const found = await engine.palettes(file.name, new Uint8Array(await file.arrayBuffer())).catch(() => []);
        add(found, true);
        setUseOwn(false);
        setNoPalettesIn(found.length ? null : file.name);
    };

    return (
        <div className='cell-row cell-row--boxed'>
            <div className='cell cell--stage'>
                <div className={`image-stage ${zoom === 'fit' ? '' : 'image-stage--pannable'}`} {...pan} onPointerCancel={pan.onPointerUp}>
                    <canvas
                        ref={canvas}
                        className={`image-canvas ${view === 'sheet' ? 'image-canvas--sheet' : ''}`}
                        style={zoomStyle(zoom, (view === 'sheet' ? sheetCanvas?.width : frames[frame].width) ?? 0, (view === 'sheet' ? sheetCanvas?.height : frames[frame].height) ?? 0)}
                        onClick={clickSheet}
                    />
                </div>
            </div>
            <div className='cell cell--side'>
                {frames.length > 1 && (
                    <div className='mb-3'>
                        <ButtonGroup size='sm' className='mb-2 d-flex'>
                            <Button variant={view === 'sheet' ? 'primary' : 'outline-light'} onClick={() => setView('sheet')}>
                                {columns ? 'Assembled' : 'All frames'}
                            </Button>
                            <Button variant={view === 'frame' ? 'primary' : 'outline-light'} onClick={() => setView('frame')}>
                                {columns ? 'One tile' : 'One frame'}
                            </Button>
                        </ButtonGroup>
                        {view === 'frame' && (
                            <div className='d-flex align-items-center gap-2'>
                                <Button size='sm' variant='outline-light' onClick={() => setPlaying((p) => !p)} aria-label={playing ? 'Pause' : 'Play'}>
                                    <i className={`bi ${playing ? 'bi-pause-fill' : 'bi-play-fill'}`} />
                                </Button>
                                <Form.Range min={0} max={frames.length - 1} value={frame} onChange={(e) => setFrame(Number(e.target.value))} aria-label='Frame' />
                                <span className='text-nowrap small'>
                                    {frame + 1} / {frames.length}
                                </span>
                            </div>
                        )}
                        {view === 'sheet' && (
                            <div className='small'>
                                <Muted>Click a frame to look at it on its own.</Muted>
                            </div>
                        )}
                    </div>
                )}

                <ZoomButtons zoom={zoom} onChange={setZoom} />
                {toggle && <Form.Check type='switch' id='images-toggle' className='mb-3' label={toggle.label} checked={on} onChange={(e) => setOn(e.target.checked)} />}
                <OffNote waiting={off.waiting} error={off.error} />

                {legend && (
                    <ul className='list-unstyled small mb-3 legend'>
                        {legend.map(({ label, index }) => (
                            <li key={index} className='d-flex align-items-center gap-2'>
                                <span className='legend-swatch' style={{ background: `rgb(${palette[index * 3]}, ${palette[index * 3 + 1]}, ${palette[index * 3 + 2]})` }} />
                                {label}
                            </li>
                        ))}
                    </ul>
                )}

                {remap && <TeamColorSelect team={team.team} onChange={team.setTeam} range={remap} />}

                <Form.Group className='mb-3'>
                    <Form.Label className='small text-body-secondary mb-1'>Palette</Form.Label>
                    {ownPalette && <Form.Check type='switch' id='own-palette' label='Use the palette in this file' checked={useOwn} onChange={(e) => setUseOwn(e.target.checked)} className='mb-2' />}
                    {!(ownPalette && useOwn) && <PaletteSelect />}
                    <div className='small mt-1'>
                        <Tip label="A .pal file, or a MIX that has palettes in it (TEMPERAT.MIX, or Red Alert's REDALERT.MIX). Palettes in any archive you open are picked up too.">
                            <button type='button' className='btn btn-link btn-sm p-0' onClick={() => paletteInput.current?.click()}>
                                Load a palette…
                            </button>
                        </Tip>
                        {noPalettesIn && <div className='text-warning'>No palettes found in {noPalettesIn}.</div>}
                    </div>
                    <input ref={paletteInput} type='file' hidden onChange={(e) => void loadPalette(e.target.files?.[0]).finally(() => (e.target.value = ''))} />
                </Form.Group>

                <div className='d-flex flex-wrap gap-2'>
                    <Button
                        size='sm'
                        variant='outline-light'
                        onClick={async () => download(await png(frameCanvas(frames[frame], paint)), `${safeName(stem(fileName))}${frames.length > 1 ? `-${String(frame).padStart(4, '0')}` : ''}.png`)}>
                        <i className='bi bi-image me-1' /> {frames.length > 1 ? 'This frame' : 'Save'} PNG
                    </Button>
                    {frames.length > 1 && (
                        <>
                            <Button size='sm' variant='outline-light' onClick={async () => download(await png(sheet(frames, paint, columns)), `${safeName(stem(fileName))}-sheet.png`)}>
                                <i className='bi bi-grid-3x3 me-1' /> {columns ? 'Assembled' : 'Sheet'} PNG
                            </Button>
                            <Button size='sm' variant='outline-light' disabled={busy} onClick={() => void saveAll()}>
                                {busy ? <Spinner animation='border' size='sm' className='me-1' /> : <i className='bi bi-file-zip me-1' />} Every frame
                            </Button>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

/**
 * Dragging with the left button scrolls the element: grab and pan a picture bigger than its stage.
 * It pans once the pointer has moved a few pixels, so a plain click still reaches what's under it
 * (a frame in a sheet), and the click that ends a drag is swallowed.
 */
function useDragPan<T extends HTMLElement>() {
    const drag = useRef<{ x: number; y: number; left: number; top: number; moving: boolean } | null>(null);
    const dragged = useRef(false);
    return {
        onPointerDown: (e: React.PointerEvent<T>) => {
            const el = e.currentTarget;
            dragged.current = false;
            if (e.button !== 0 || (el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight)) return;
            drag.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop, moving: false };
            e.preventDefault();
        },
        onPointerMove: (e: React.PointerEvent<T>) => {
            const d = drag.current;
            if (!d) return;
            if (!d.moving) {
                if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 3) return;
                d.moving = true;
                e.currentTarget.setPointerCapture(e.pointerId);
                e.currentTarget.classList.add('is-panning');
            }
            e.currentTarget.scrollLeft = d.left - (e.clientX - d.x);
            e.currentTarget.scrollTop = d.top - (e.clientY - d.y);
        },
        onPointerUp: (e: React.PointerEvent<T>) => {
            dragged.current = !!drag.current?.moving;
            drag.current = null;
            e.currentTarget.classList.remove('is-panning');
        },
        onClickCapture: (e: React.MouseEvent<T>) => {
            if (!dragged.current) return;
            dragged.current = false;
            e.stopPropagation();
        },
    };
}

function PicturePreview({ width, height, rgba, toggle, fileName }: { width: number; height: number; rgba: Uint8Array; toggle?: { label: string; off(): Promise<Uint8Array> }; fileName: string }) {
    const canvas = useRef<HTMLCanvasElement>(null);
    const pan = useDragPan<HTMLDivElement>();
    // Big pictures (whole maps) start fitted to the page.
    const [zoom, setZoom] = useState<Zoom>(initialZoom(width));
    const [on, setOn] = useState(true);
    // The picture with the switch off is drawn the first time it's wanted, then kept.
    const off = useOff(toggle, on);
    const shown = on || !toggle || !off.other ? rgba : off.other;

    useEffect(() => {
        const el = canvas.current;
        if (!el) return;
        el.width = width;
        el.height = height;
        // A view of the same pixels, not a copy: a whole map can be hundreds of megabytes.
        el.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(shown.buffer as ArrayBuffer, shown.byteOffset, width * height * 4), width, height), 0, 0);
    }, [width, height, shown]);

    return (
        <div className='cell-row cell-row--boxed'>
            <div className='cell cell--stage'>
                <div className={`image-stage ${zoom === 'fit' ? '' : 'image-stage--pannable'}`} {...pan} onPointerCancel={pan.onPointerUp}>
                    <canvas ref={canvas} className='image-canvas' style={zoomStyle(zoom, width, height)} />
                </div>
            </div>
            <div className='cell cell--side'>
                <ZoomButtons zoom={zoom} onChange={setZoom} />
                {toggle && <Form.Check type='switch' id='picture-toggle' className='mb-3' label={toggle.label} checked={on} onChange={(e) => setOn(e.target.checked)} />}
                <OffNote waiting={off.waiting} error={off.error} />
                <Button size='sm' variant='outline-light' onClick={async () => canvas.current && download(await png(canvas.current), `${safeName(stem(fileName))}.png`)}>
                    <i className='bi bi-image me-1' /> Save PNG
                </Button>
            </div>
        </div>
    );
}

function PalettePreview({ colors, fileName }: { colors: Uint8Array; fileName: string }) {
    const { add, current } = usePalettes();
    const id = `opened:${fileName}:${colors.slice(0, 12).join(',')}`;
    return (
        <>
            <div className='palette-grid'>
                {Array.from({ length: 256 }, (_, i) => {
                    const rgb = `#${[colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
                    return (
                        <Tip key={i} label={`${i} (0x${i.toString(16).toUpperCase().padStart(2, '0')})\n${rgb}`}>
                            <span className='palette-swatch' style={{ background: rgb }} />
                        </Tip>
                    );
                })}
            </div>
            <Button className='mt-3' variant={current.id === id ? 'success' : 'outline-light'} onClick={() => add([{ id, label: fileName, colors }], true)}>
                <i className={`bi ${current.id === id ? 'bi-check2' : 'bi-palette'} me-1`} /> {current.id === id ? 'Used for sprites' : 'Use for sprites'}
            </Button>
        </>
    );
}

/** A blob URL for a WAV, made and revoked by the same effect, so it lives exactly as long as it's shown (seeking re-reads it). */
function useWavUrl(wav: Uint8Array | undefined, mime = 'audio/wav'): string | undefined {
    // The URL is something outside React (the browser's blob store), so an effect makes and revokes it. Made during render
    // instead, StrictMode's second mount would be left holding a URL already revoked.
    const [made, setMade] = useState<{ wav: Uint8Array; url: string }>();
    useEffect(() => {
        if (!wav) return;
        const url = URL.createObjectURL(new Blob([wav as Uint8Array<ArrayBuffer>], { type: mime }));
        // oxlint-disable-next-line react/set-state-in-effect -- handing over what the effect made, as above
        setMade({ wav, url });
        return () => URL.revokeObjectURL(url);
    }, [wav, mime]);
    // Only the URL for this sound: never one left from the sound before, or from none.
    return made && made.wav === wav ? made.url : undefined;
}

const channelsLabel = (channels: number) => (channels === 1 ? 'mono' : channels === 2 ? 'stereo' : `${channels} channels`);
const clipLabel = (clip: AudioClip) => `${clip.seconds.toFixed(2)} s · ${clip.sampleRate} Hz · ${clip.bits ? `${clip.bits}-bit ` : ''}${channelsLabel(clip.channels)}`;

/** The extension to save a clip under, for the files the browser plays as they are. */
const CLIP_EXTENSIONS: Record<string, string> = { 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg' };

function AudioPreview({ clip, fileName }: { clip: AudioClip; fileName: string }) {
    const url = useWavUrl(clip.wav, clip.mime);
    const extension = (clip.mime && CLIP_EXTENSIONS[clip.mime]) || 'wav';
    return (
        <div className='d-flex flex-wrap gap-3 align-items-center'>
            {/* A game's sound has no captions to offer: there's no track to give it. */}
            {/* oxlint-disable-next-line jsx-a11y/media-has-caption */}
            <audio controls src={url} className='audio-player' />
            <Button variant='outline-light' onClick={() => download(clip.wav, `${safeName(stem(fileName))}.${extension}`, clip.mime ?? 'audio/wav')}>
                <i className='bi bi-file-earmark-music me-1' /> Save as {extension.toUpperCase()}
            </Button>
            <Muted>{clipLabel(clip)}</Muted>
        </div>
    );
}

/**
 * Plays a movie by decoding frames as they're needed. With sound, the sound is
 * the clock and the picture follows it.
 */
function VideoPreview({ preview, fileName }: { preview: Extract<UiPreview, { kind: 'video' }>; fileName: string }) {
    const { width, height, frameCount, fps, audio } = preview;
    const [frame, setFrame] = useState(0);
    const [playing, setPlaying] = useState(false);
    const [zoom, setZoom] = useState(width <= 320 ? 2 : 1);
    const pan = useDragPan<HTMLDivElement>();
    const [busy, setBusy] = useState<string | null>(null);
    const canvas = useRef<HTMLCanvasElement>(null);
    const sound = useRef<HTMLAudioElement>(null);
    const url = useWavUrl(audio?.wav);
    const shown = useRef(-1);

    const [error, setError] = useState<string | null>(null);
    const image = (f: VideoFrame) => ('rgba' in f ? new ImageData(new Uint8ClampedArray(f.rgba), width, height) : toImageData({ width, height, pixels: f.pixels }, { palette: f.palette }));

    // Frames are decoded in the parsing worker: one at a time, the latest wanted, so playing never queues up behind itself.
    const wanted = useRef(0);
    const drawing = useRef(false);
    const draw = () => {
        if (drawing.current || !canvas.current || shown.current === wanted.current) return;
        const index = wanted.current;
        drawing.current = true;
        preview
            .frame(index)
            .then(
                (f) => canvas.current?.getContext('2d')!.putImageData(image(f), 0, 0),
                (e: unknown) => {
                    setError(`Frame ${index + 1} couldn't be decoded: ${e instanceof Error ? e.message : String(e)}`);
                    setPlaying(false);
                }
            )
            .finally(() => {
                shown.current = index;
                drawing.current = false;
                draw();
            });
    };
    useEffect(() => {
        wanted.current = frame;
        draw();
    });

    // Where play starts: the frame on screen when it's pressed, read without making every frame restart the clock.
    const startFrame = useEffectEvent(() => frame);
    useEffect(() => {
        if (!playing) return;
        const el = sound.current;
        if (el) {
            if (el.currentTime >= el.duration - 0.05) el.currentTime = 0;
            void el.play();
        }
        const start = performance.now() - (startFrame() / fps) * 1000;
        let request = 0;
        const tick = () => {
            const seconds = el ? el.currentTime : (performance.now() - start) / 1000;
            const next = Math.floor(seconds * fps);
            if (next >= frameCount || (el && el.ended)) {
                setFrame(frameCount - 1);
                setPlaying(false);
                return;
            }
            setFrame(next);
            request = requestAnimationFrame(tick);
        };
        request = requestAnimationFrame(tick);
        return () => {
            cancelAnimationFrame(request);
            el?.pause();
        };
    }, [playing, fps, frameCount]);

    const seek = (index: number) => {
        setFrame(index);
        if (sound.current) sound.current.currentTime = index / fps;
    };

    const framePng = async (index: number) => {
        const c = document.createElement('canvas');
        c.width = width;
        c.height = height;
        c.getContext('2d')!.putImageData(image(await preview.frame(index)), 0, 0);
        return png(c);
    };

    const saveAll = async () => {
        const files: { name: string; data: Uint8Array }[] = [];
        try {
            for (let i = 0; i < frameCount; i++) {
                if (i % 50 === 0) {
                    setBusy(`${i} / ${frameCount}`);
                    await new Promise((r) => setTimeout(r, 0));
                }
                files.push({ name: `${stem(fileName)}-${String(i).padStart(4, '0')}.png`, data: new Uint8Array(await (await framePng(i)).arrayBuffer()) });
            }
            download(zip(files), `${safeName(stem(fileName))}-frames.zip`);
        } finally {
            setBusy(null);
            shown.current = -1;
        }
    };

    return (
        <div className='cell-row cell-row--boxed'>
            <div className='cell cell--stage'>
                <div className='image-stage image-stage--pannable' {...pan} onPointerCancel={pan.onPointerUp}>
                    <canvas ref={canvas} width={width} height={height} className='image-canvas' style={{ width: width * zoom }} />
                </div>
            </div>
            <div className='cell cell--side'>
                <div className='d-flex align-items-center gap-2 mb-3'>
                    <Button size='sm' variant='outline-light' onClick={() => setPlaying((p) => !p)} aria-label={playing ? 'Pause' : 'Play'}>
                        <i className={`bi ${playing ? 'bi-pause-fill' : 'bi-play-fill'}`} />
                    </Button>
                    <Form.Range min={0} max={frameCount - 1} value={frame} onChange={(e) => seek(Number(e.target.value))} aria-label='Frame' />
                    <span className='text-nowrap small'>
                        {frame + 1} / {frameCount}
                    </span>
                </div>
                {/* The movie's own sound, played along with it; there are no captions to give it. */}
                {/* oxlint-disable-next-line jsx-a11y/media-has-caption */}
                {url && <audio ref={sound} src={url} preload='auto' />}
                {error && <p className='small text-danger'>{error}</p>}

                <Form.Group className='mb-3'>
                    <Form.Label className='small text-body-secondary mb-1'>Zoom</Form.Label>
                    <ButtonGroup size='sm' className='d-flex'>
                        {[1, 2, 3].map((z) => (
                            <Button key={z} variant={zoom === z ? 'primary' : 'outline-light'} onClick={() => setZoom(z)}>
                                {z}×
                            </Button>
                        ))}
                    </ButtonGroup>
                </Form.Group>

                <p className='small mb-3'>
                    <Muted>
                        {width} × {height} · {fps} fps · {(frameCount / fps).toFixed(1)} s{audio ? ` · sound: ${clipLabel(audio)}` : ' · no sound'}
                    </Muted>
                </p>

                <div className='d-flex flex-wrap gap-2'>
                    <Button size='sm' variant='outline-light' onClick={async () => download(await framePng(frame), `${safeName(stem(fileName))}-${String(frame).padStart(4, '0')}.png`)}>
                        <i className='bi bi-image me-1' /> This frame PNG
                    </Button>
                    <Button size='sm' variant='outline-light' disabled={busy !== null || playing} onClick={() => void saveAll()}>
                        {busy !== null ? <Spinner animation='border' size='sm' className='me-1' /> : <i className='bi bi-file-zip me-1' />} {busy ?? 'Every frame'}
                    </Button>
                    {audio && (
                        <Button size='sm' variant='outline-light' onClick={() => download(audio.wav, `${safeName(stem(fileName))}.wav`, 'audio/wav')}>
                            <i className='bi bi-file-earmark-music me-1' /> Sound as WAV
                        </Button>
                    )}
                </div>
            </div>
        </div>
    );
}
