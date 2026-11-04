import { Badge, Button, ListGroup, Offcanvas } from 'react-bootstrap';
import { formatSize } from '../core/bytes';
import { useLibrary } from '../lib/library';
import { AddFilesButton } from './AddFiles';
import { Muted } from './ui';

/**
 * The files in use this session: what's been opened or added, what each brought
 * for other files to use, and a way to remove them or add more.
 */
export function FilesPanel({ show, onHide }: { show: boolean; onHide: () => void }) {
    const { files, remove } = useLibrary();
    return (
        <Offcanvas show={show} onHide={onHide} placement="end" className="files-panel">
            <Offcanvas.Header closeButton closeVariant="white">
                <Offcanvas.Title>Files in use</Offcanvas.Title>
            </Offcanvas.Header>
            <Offcanvas.Body>
                <p className="small text-body-secondary">
                    Files you open, and files you add here, stay available for the rest of the session so other files can use them: a map draws with its theater's tiles, a voxel model finds its animation, a sound index plays from its sound bank. Names in their INIs also help name files in other archives.
                </p>
                <p className="small text-body-secondary">They're kept until you remove them or close the tab. Nothing leaves your computer.</p>
                <div className="mb-3">
                    <AddFilesButton variant="primary" />
                </div>
                {files.length === 0 ? (
                    <Muted>Nothing yet. Open a file to start.</Muted>
                ) : (
                    <ListGroup variant="flush">
                        {files.map((f) => (
                            <ListGroup.Item key={f.id} className="d-flex align-items-start gap-2 px-0 bg-transparent">
                                <div className="flex-grow-1 min-width-0">
                                    <div className="font-monospace text-break">
                                        {f.id}{' '}
                                        <Badge bg={f.how === 'opened' ? 'primary' : 'secondary'} className="ms-1">
                                            {f.how === 'opened' ? 'opened' : 'added'}
                                        </Badge>
                                    </div>
                                    <div className="small text-body-secondary">
                                        {formatSize(f.size)}
                                        {f.files > 0 && ` · ${f.files.toLocaleString('en-US')} named files${f.archives ? ` in ${f.archives + 1} archives` : ''}`}
                                        {f.texts > 0 && ` · names learned from ${f.texts} INI and text file${f.texts === 1 ? '' : 's'}`}
                                    </div>
                                </div>
                                <Button size="sm" variant="outline-light" onClick={() => remove(f.id)} aria-label={`Remove ${f.id}`}>
                                    <i className="bi bi-x-lg" />
                                </Button>
                            </ListGroup.Item>
                        ))}
                    </ListGroup>
                )}
            </Offcanvas.Body>
        </Offcanvas>
    );
}
