import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { Button, ButtonGroup, Form } from 'react-bootstrap';
import type { VoxelPart } from '../core/types';
import { Muted } from '../components/ui';
import { download, safeName } from '../lib/download';
import { PaletteSelect, usePalettes } from '../lib/palettes';
import { TeamColorSelect, useTeamColor } from '../components/TeamColor';

/**
 * A voxel model in 3D (WebGL2): each voxel's visible faces as a mesh, colored
 * through the palette in the shader so switching palettes is instant, and lit
 * by each voxel's normal the way the games do. Drag to turn it, scroll to zoom, double-click to reset.
 */

type Mat4 = Float32Array;

const identity = (): Mat4 => Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);

/** a × b, column-major. */
function multiply(a: Mat4, b: Mat4): Mat4 {
    const out = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
    return out;
}

/** Where a part's voxel coordinates go in the model at a frame: its bounds, then its animation's 3 × 4 transform. */
function partMatrix(part: VoxelPart, frame: number): Mat4 {
    const box = identity();
    for (let i = 0; i < 3; i++) {
        box[i * 5] = (part.max[i] - part.min[i]) / (part.size[i] || 1);
        box[12 + i] = part.min[i];
    }
    const m = part.frames[Math.min(frame, part.frames.length - 1)];
    const placed = m ? multiply(Float32Array.of(m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, m[3], m[7], m[11], 1), box) : box;
    if (part.offset) for (let i = 0; i < 3; i++) placed[12 + i] += part.offset[i];
    return placed;
}

/** The inverse transpose of a matrix's upper 3 × 3, for turning normals. */
function normalMatrix(m: Mat4): Float32Array {
    const [a, b, c, d, e, f, g, h, i] = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
    const det = a * (e * i - f * h) - d * (b * i - c * h) + g * (b * f - c * e) || 1;
    return Float32Array.of(
        (e * i - f * h) / det,
        (g * f - d * i) / det,
        (d * h - g * e) / det,
        (c * h - b * i) / det,
        (a * i - g * c) / det,
        (g * b - a * h) / det,
        (b * f - e * c) / det,
        (d * c - a * f) / det,
        (a * e - d * b) / det
    );
}

const FACES: { normal: [number, number, number]; corners: [number, number, number][] }[] = [
    {
        normal: [1, 0, 0],
        corners: [
            [1, 0, 0],
            [1, 1, 0],
            [1, 1, 1],
            [1, 0, 1],
        ],
    },
    {
        normal: [-1, 0, 0],
        corners: [
            [0, 1, 0],
            [0, 0, 0],
            [0, 0, 1],
            [0, 1, 1],
        ],
    },
    {
        normal: [0, 1, 0],
        corners: [
            [1, 1, 0],
            [0, 1, 0],
            [0, 1, 1],
            [1, 1, 1],
        ],
    },
    {
        normal: [0, -1, 0],
        corners: [
            [0, 0, 0],
            [1, 0, 0],
            [1, 0, 1],
            [0, 0, 1],
        ],
    },
    {
        normal: [0, 0, 1],
        corners: [
            [0, 0, 1],
            [1, 0, 1],
            [1, 1, 1],
            [0, 1, 1],
        ],
    },
    {
        normal: [0, 0, -1],
        corners: [
            [0, 1, 0],
            [1, 1, 0],
            [1, 0, 0],
            [0, 0, 0],
        ],
    },
];

/** The faces of a part's voxels that nothing covers: position, normal and color index per vertex, two triangles a face. */
function buildMesh(part: VoxelPart): Float32Array {
    const [sx, sy, sz] = part.size;
    const at = (x: number, y: number, z: number) => (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz ? 0 : part.colors[x + sx * (y + sy * z)]);
    const out: number[] = [];
    for (let z = 0; z < sz; z++) {
        for (let y = 0; y < sy; y++) {
            for (let x = 0; x < sx; x++) {
                const color = at(x, y, z);
                if (!color) continue;
                const i = (x + sx * (y + sy * z)) * 3;
                const own = part.normals && (part.normals[i] || part.normals[i + 1] || part.normals[i + 2]) ? [part.normals[i], part.normals[i + 1], part.normals[i + 2]] : null;
                for (const { normal, corners } of FACES) {
                    if (at(x + normal[0], y + normal[1], z + normal[2])) continue;
                    // The game lights a voxel by its own normal, the same on every face; without one, by the face's.
                    const n = own ?? normal;
                    for (const k of [0, 1, 2, 0, 2, 3]) out.push(x + corners[k][0], y + corners[k][1], z + corners[k][2], n[0], n[1], n[2], color);
                }
            }
        }
    }
    return Float32Array.from(out);
}

const VERTEX = `#version 300 es
in vec3 aPos;
in vec3 aNormal;
in float aColor;
uniform mat4 uProjection;
uniform mat4 uView;
uniform mat4 uModel;
uniform mat3 uNormal;
uniform sampler2D uPalette;
out vec3 vColor;
out float vLight;
void main() {
    gl_Position = uProjection * uView * uModel * vec4(aPos, 1.0);
    vec3 n = normalize(uNormal * aNormal);
    // The TS/RA2 mission editor's light (EA's GPL source): from (1, 0, -1), against each voxel's normal. Its
    // brightness, (200 + 300 * light) / 255, washes colors out here, so the range is gentler: 0.7 to 1.25.
    vLight = 0.7 + 0.55 * max(dot(n, normalize(vec3(-1.0, 0.0, 1.0))), 0.0);
    vColor = texelFetch(uPalette, ivec2(int(aColor), 0), 0).rgb;
}`;

const FRAGMENT = `#version 300 es
precision mediump float;
in vec3 vColor;
in float vLight;
out vec4 color;
void main() {
    color = vec4(min(vColor * vLight, 1.0), 1.0);
}`;

function compile(gl: WebGL2RenderingContext): WebGLProgram {
    const program = gl.createProgram()!;
    for (const [type, source] of [
        [gl.VERTEX_SHADER, VERTEX],
        [gl.FRAGMENT_SHADER, FRAGMENT],
    ] as const) {
        const shader = gl.createShader(type)!;
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'shader');
        gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'program');
    return program;
}

/** The model's center and size across all parts at the first frame, for the camera. */
function bounds(parts: VoxelPart[]): { center: [number, number, number]; radius: number } {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const part of parts) {
        const m = partMatrix(part, 0);
        for (const corner of [0, 1, 2, 3, 4, 5, 6, 7]) {
            const p = [corner & 1 ? part.size[0] : 0, corner & 2 ? part.size[1] : 0, corner & 4 ? part.size[2] : 0];
            for (let i = 0; i < 3; i++) {
                const v = m[i] * p[0] + m[4 + i] * p[1] + m[8 + i] * p[2] + m[12 + i];
                lo[i] = Math.min(lo[i], v);
                hi[i] = Math.max(hi[i], v);
            }
        }
    }
    if (!Number.isFinite(lo[0])) return { center: [0, 0, 0], radius: 1 };
    return { center: [0, 1, 2].map((i) => (lo[i] + hi[i]) / 2) as [number, number, number], radius: Math.max(1, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2) };
}

interface Camera {
    yaw: number;
    pitch: number;
    zoom: number;
}

/** The games' view: from the south-east, looking down. */
const GAME_VIEW: Camera = { yaw: -Math.PI / 4 - Math.PI / 2, pitch: 0.6, zoom: 1 };

export function VoxelViewer({ parts, frameCount, ownPalette, remap, fileName }: { parts: VoxelPart[]; frameCount: number; ownPalette?: Uint8Array; remap?: [number, number]; fileName: string }) {
    const { current } = usePalettes();
    const [useOwn, setUseOwn] = useState(false);
    const team = useTeamColor(ownPalette && useOwn ? ownPalette : current.colors, remap);
    const palette = team.palette;
    const [camera, setCamera] = useState<Camera>(GAME_VIEW);
    const [perspective, setPerspective] = useState(false);
    const [spin, setSpin] = useState(false);
    const [frame, setFrame] = useState(0);
    const [playing, setPlaying] = useState(false);
    const [hidden, setHidden] = useState<Set<number>>(new Set());
    // Why 3D can't be shown, for the parts it was tried with (so other parts get a fresh try).
    const [failure, setFailure] = useState<{ parts: typeof parts; message: string }>();
    const error = failure?.parts === parts ? failure.message : null;
    const canvas = useRef<HTMLCanvasElement>(null);
    const gpu = useRef<{ gl: WebGL2RenderingContext; program: WebGLProgram; meshes: { vao: WebGLVertexArrayObject; count: number }[]; palette: WebGLTexture } | null>(null);
    const { center, radius } = useMemo(() => bounds(parts), [parts]);

    // Set up WebGL and upload each part's mesh once.
    useEffect(() => {
        const el = canvas.current;
        const gl = el?.getContext('webgl2', { antialias: true, preserveDrawingBuffer: true });
        if (!el || !gl) {
            // oxlint-disable-next-line react/set-state-in-effect -- what WebGL (outside React) said
            setFailure({ parts, message: "This browser can't show 3D (no WebGL2)." });
            return;
        }
        try {
            const program = compile(gl);
            const meshes = parts.map((part) => {
                const data = buildMesh(part);
                const vao = gl.createVertexArray()!;
                gl.bindVertexArray(vao);
                gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
                gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
                const attribute = (name: string, size: number, offset: number) => {
                    const loc = gl.getAttribLocation(program, name);
                    gl.enableVertexAttribArray(loc);
                    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 28, offset);
                };
                attribute('aPos', 3, 0);
                attribute('aNormal', 3, 12);
                attribute('aColor', 1, 24);
                return { vao, count: data.length / 7 };
            });
            const texture = gl.createTexture()!;
            gpu.current = { gl, program, meshes, palette: texture };
        } catch (e) {
            // oxlint-disable-next-line react/set-state-in-effect -- as above: what WebGL said
            setFailure({ parts, message: `3D isn't available here: ${e instanceof Error ? e.message : e}` });
        }
        return () => {
            gpu.current = null;
        };
    }, [parts]);

    // Drawing: on any change, and every frame while playing or spinning.
    // An effect event: it always sees the latest camera, frame and palette, and runs only from effects and what they set up.
    const draw = useEffectEvent(() => {
        const g = gpu.current;
        const el = canvas.current;
        if (!g || !el) return;
        const { gl, program, meshes } = g;
        const [cam, persp, f, off, pal] = [camera, perspective, frame, hidden, palette];
        const scale = window.devicePixelRatio || 1;
        const [w, h] = [Math.round(el.clientWidth * scale), Math.round(el.clientHeight * scale)];
        if (el.width !== w || el.height !== h) [el.width, el.height] = [w, h];
        gl.viewport(0, 0, w, h);
        gl.clearColor(0.165, 0.184, 0.208, 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.DEPTH_TEST);
        gl.useProgram(program);

        const rgba = new Uint8Array(256 * 4);
        for (let i = 0; i < 256; i++) rgba.set([pal[i * 3], pal[i * 3 + 1], pal[i * 3 + 2], 255], i * 4);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, g.palette);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.uniform1i(gl.getUniformLocation(program, 'uPalette'), 0);

        // Orbit the model's center, z up.
        const distance = radius * 3;
        const eye = [Math.cos(cam.pitch) * Math.cos(cam.yaw), Math.cos(cam.pitch) * Math.sin(cam.yaw), Math.sin(cam.pitch)];
        const forward = eye.map((v) => -v);
        const rightRaw = [forward[1], -forward[0], 0];
        const rl = Math.hypot(rightRaw[0], rightRaw[1]) || 1;
        const right = rightRaw.map((v) => v / rl);
        const up = [right[1] * forward[2] - right[2] * forward[1], right[2] * forward[0] - right[0] * forward[2], right[0] * forward[1] - right[1] * forward[0]];
        const pos = center.map((c, i) => c + eye[i] * distance);
        const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        const view = Float32Array.of(right[0], up[0], -forward[0], 0, right[1], up[1], -forward[1], 0, right[2], up[2], -forward[2], 0, -dot(right, pos), -dot(up, pos), dot(forward, pos), 1);
        const aspect = w / h;
        const [near, far] = [distance * 0.05, distance * 4];
        let projection: Mat4;
        if (persp) {
            const t = 1 / Math.tan(0.35 / cam.zoom);
            projection = Float32Array.of(t / aspect, 0, 0, 0, 0, t, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0);
        } else {
            const half = (radius * 1.15) / cam.zoom;
            projection = Float32Array.of(1 / (half * aspect), 0, 0, 0, 0, 1 / half, 0, 0, 0, 0, -2 / (far - near), 0, 0, 0, -(far + near) / (far - near), 1);
        }
        gl.uniformMatrix4fv(gl.getUniformLocation(program, 'uProjection'), false, projection);
        gl.uniformMatrix4fv(gl.getUniformLocation(program, 'uView'), false, view);
        meshes.forEach((mesh, i) => {
            if (off.has(i)) return;
            const model = partMatrix(parts[i], f);
            gl.uniformMatrix4fv(gl.getUniformLocation(program, 'uModel'), false, model);
            gl.uniformMatrix3fv(gl.getUniformLocation(program, 'uNormal'), false, normalMatrix(model));
            gl.bindVertexArray(mesh.vao);
            gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
        });
    });

    useEffect(() => draw());

    useEffect(() => {
        if (!spin && !playing) return;
        let last = performance.now();
        let elapsed = 0;
        let request = 0;
        const tick = (now: number) => {
            const dt = now - last;
            last = now;
            if (spin) setCamera((c) => ({ ...c, yaw: c.yaw + dt * 0.0006 }));
            if (playing) {
                elapsed += dt;
                // HVA animations run at the game's 15 frames a second.
                if (elapsed > 1000 / 15) {
                    elapsed = 0;
                    setFrame((f) => (f + 1) % frameCount);
                }
            }
            request = requestAnimationFrame(tick);
        };
        request = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(request);
    }, [spin, playing, frameCount]);

    // Redraw when the canvas changes size.
    useEffect(() => {
        const el = canvas.current;
        if (!el) return;
        const observer = new ResizeObserver(() => draw());
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    // Turning and zooming: drag, wheel (kept from scrolling the page), double-click to reset.
    useEffect(() => {
        const el = canvas.current;
        if (!el) return;
        const wheel = (e: WheelEvent) => {
            e.preventDefault();
            setCamera((c) => ({ ...c, zoom: Math.min(20, Math.max(0.2, c.zoom * Math.exp(-e.deltaY * 0.0015))) }));
        };
        el.addEventListener('wheel', wheel, { passive: false });
        return () => el.removeEventListener('wheel', wheel);
    }, []);
    const dragging = useRef<{ x: number; y: number } | null>(null);

    // The canvas keeps what it last drew (preserveDrawingBuffer), so it's saved as it is.
    const savePng = () => {
        canvas.current?.toBlob((blob) => blob && download(blob, `${safeName(fileName.replace(/\.[^.]+$/, ''))}-3d.png`), 'image/png');
    };

    return (
        <div className='cell-row cell-row--boxed'>
            <div className='cell cell--stage'>
                {error ? (
                    <div className='image-stage align-items-center' style={{ height: 'auto' }}>
                        <Muted>{error}</Muted>
                    </div>
                ) : (
                    <canvas
                        ref={canvas}
                        className='voxel-canvas'
                        onPointerDown={(e) => {
                            dragging.current = { x: e.clientX, y: e.clientY };
                            e.currentTarget.setPointerCapture(e.pointerId);
                        }}
                        onPointerMove={(e) => {
                            const d = dragging.current;
                            if (!d) return;
                            const [dx, dy] = [e.clientX - d.x, e.clientY - d.y];
                            dragging.current = { x: e.clientX, y: e.clientY };
                            setCamera((c) => ({ ...c, yaw: c.yaw - dx * 0.01, pitch: Math.max(-1.5, Math.min(1.5, c.pitch + dy * 0.01)) }));
                        }}
                        onPointerUp={() => (dragging.current = null)}
                        onDoubleClick={() => setCamera(GAME_VIEW)}
                    />
                )}
                <div className='small mt-2'>
                    <Muted>Drag to turn, scroll to zoom, double-click to go back to the game's view.</Muted>
                </div>
            </div>
            <div className='cell cell--side'>
                <Form.Group className='mb-3'>
                    <Form.Label className='small text-body-secondary mb-1'>View</Form.Label>
                    <div className='d-flex flex-wrap gap-2'>
                        <Button size='sm' variant='outline-light' onClick={() => setCamera(GAME_VIEW)}>
                            Game view
                        </Button>
                        <ButtonGroup size='sm'>
                            <Button variant={perspective ? 'outline-light' : 'primary'} onClick={() => setPerspective(false)}>
                                Flat
                            </Button>
                            <Button variant={perspective ? 'primary' : 'outline-light'} onClick={() => setPerspective(true)}>
                                Perspective
                            </Button>
                        </ButtonGroup>
                        <Button size='sm' variant={spin ? 'primary' : 'outline-light'} onClick={() => setSpin((s) => !s)}>
                            <i className='bi bi-arrow-repeat me-1' /> Spin
                        </Button>
                    </div>
                </Form.Group>

                {frameCount > 1 && (
                    <Form.Group className='mb-3'>
                        <Form.Label className='small text-body-secondary mb-1'>Animation</Form.Label>
                        <div className='d-flex align-items-center gap-2'>
                            <Button size='sm' variant='outline-light' onClick={() => setPlaying((p) => !p)} aria-label={playing ? 'Pause' : 'Play'}>
                                <i className={`bi ${playing ? 'bi-pause-fill' : 'bi-play-fill'}`} />
                            </Button>
                            <Form.Range min={0} max={frameCount - 1} value={frame} onChange={(e) => setFrame(Number(e.target.value))} aria-label='Frame' />
                            <span className='text-nowrap small'>
                                {frame + 1} / {frameCount}
                            </span>
                        </div>
                    </Form.Group>
                )}

                {parts.length > 1 && (
                    <Form.Group className='mb-3'>
                        <Form.Label className='small text-body-secondary mb-1'>Parts</Form.Label>
                        {parts.map((p, i) => (
                            <Form.Check
                                key={i}
                                type='switch'
                                id={`part-${i}`}
                                label={p.name}
                                checked={!hidden.has(i)}
                                onChange={(e) =>
                                    setHidden((h) => {
                                        const next = new Set(h);
                                        if (e.target.checked) next.delete(i);
                                        else next.add(i);
                                        return next;
                                    })
                                }
                            />
                        ))}
                    </Form.Group>
                )}

                {remap && <TeamColorSelect team={team.team} onChange={team.setTeam} range={remap} />}

                <Form.Group className='mb-3'>
                    <Form.Label className='small text-body-secondary mb-1'>Palette</Form.Label>
                    {ownPalette && (
                        <Form.Check type='switch' id='voxel-own-palette' label='Use the palette in this file' checked={useOwn} onChange={(e) => setUseOwn(e.target.checked)} className='mb-2' />
                    )}
                    {!(ownPalette && useOwn) && <PaletteSelect />}
                    <div className='small mt-1'>
                        <Muted>The games use the unit palette (unittem.pal, in local.mix).</Muted>
                    </div>
                </Form.Group>

                <Button size='sm' variant='outline-light' onClick={savePng}>
                    <i className='bi bi-image me-1' /> Save this view as PNG
                </Button>
            </div>
        </div>
    );
}
