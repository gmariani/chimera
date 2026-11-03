/** Saves bytes or a blob as a file, without a round trip to any server. */
export function download(content: Uint8Array | Blob, name: string, type = 'application/octet-stream') {
    const blob = content instanceof Blob ? content : new Blob([content as Uint8Array<ArrayBuffer>], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Strips characters that aren't allowed in file names on Windows or macOS. */
export function safeName(name: string): string {
    return name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_') || 'file';
}
