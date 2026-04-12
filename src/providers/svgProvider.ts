import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SvgDocument, buildSvgEditorPage } from '../svgEditor';

const SVG_REPLACE_FILTERS: Record<string, string[]> = {
    'Images and SVG': ['svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'],
    'SVG': ['svg'],
    'Images': ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']
};

type ImageDimensions = {
    width: number;
    height: number;
};

function getMimeType(filePath: string): string | undefined {
    switch (path.extname(filePath).toLowerCase()) {
        case '.svg':
            return 'image/svg+xml';
        case '.png':
            return 'image/png';
        case '.jpg':
        case '.jpeg':
            return 'image/jpeg';
        case '.gif':
            return 'image/gif';
        case '.webp':
            return 'image/webp';
        case '.bmp':
            return 'image/bmp';
        default:
            return undefined;
    }
}

function readPngDimensions(buffer: Buffer): ImageDimensions | undefined {
    if (buffer.length < 24) return undefined;
    if (buffer.toString('hex', 0, 8) !== '89504e470d0a1a0a') return undefined;
    return {
        width: buffer.readUInt32BE(16),
        height: buffer.readUInt32BE(20),
    };
}

function readGifDimensions(buffer: Buffer): ImageDimensions | undefined {
    if (buffer.length < 10) return undefined;
    const sig = buffer.toString('ascii', 0, 6);
    if (sig !== 'GIF87a' && sig !== 'GIF89a') return undefined;
    return {
        width: buffer.readUInt16LE(6),
        height: buffer.readUInt16LE(8),
    };
}

function readBmpDimensions(buffer: Buffer): ImageDimensions | undefined {
    if (buffer.length < 26 || buffer.toString('ascii', 0, 2) !== 'BM') return undefined;
    return {
        width: Math.abs(buffer.readInt32LE(18)),
        height: Math.abs(buffer.readInt32LE(22)),
    };
}

function readJpegDimensions(buffer: Buffer): ImageDimensions | undefined {
    if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return undefined;

    let offset = 2;
    while (offset + 8 < buffer.length) {
        if (buffer[offset] !== 0xff) {
            offset += 1;
            continue;
        }

        const marker = buffer[offset + 1];
        offset += 2;

        if (marker === 0xd8 || marker === 0xd9) {
            continue;
        }

        if (offset + 2 > buffer.length) {
            break;
        }

        const size = buffer.readUInt16BE(offset);
        if (size < 2 || offset + size > buffer.length) {
            break;
        }

        const isSof = (marker >= 0xc0 && marker <= 0xc3)
            || (marker >= 0xc5 && marker <= 0xc7)
            || (marker >= 0xc9 && marker <= 0xcb)
            || (marker >= 0xcd && marker <= 0xcf);

        if (isSof && offset + 7 < buffer.length) {
            return {
                height: buffer.readUInt16BE(offset + 3),
                width: buffer.readUInt16BE(offset + 5),
            };
        }

        offset += size;
    }

    return undefined;
}

function readWebpDimensions(buffer: Buffer): ImageDimensions | undefined {
    if (buffer.length < 30) return undefined;
    if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') {
        return undefined;
    }

    const chunkType = buffer.toString('ascii', 12, 16);

    if (chunkType === 'VP8X' && buffer.length >= 30) {
        return {
            width: 1 + buffer.readUIntLE(24, 3),
            height: 1 + buffer.readUIntLE(27, 3),
        };
    }

    if (chunkType === 'VP8 ' && buffer.length >= 30) {
        return {
            width: buffer.readUInt16LE(26) & 0x3fff,
            height: buffer.readUInt16LE(28) & 0x3fff,
        };
    }

    if (chunkType === 'VP8L' && buffer.length >= 25) {
        const bits = buffer.readUInt32LE(21);
        return {
            width: (bits & 0x3fff) + 1,
            height: ((bits >> 14) & 0x3fff) + 1,
        };
    }

    return undefined;
}

function getImageDimensions(filePath: string, buffer: Buffer): ImageDimensions | undefined {
    switch (path.extname(filePath).toLowerCase()) {
        case '.png':
            return readPngDimensions(buffer);
        case '.jpg':
        case '.jpeg':
            return readJpegDimensions(buffer);
        case '.gif':
            return readGifDimensions(buffer);
        case '.webp':
            return readWebpDimensions(buffer);
        case '.bmp':
            return readBmpDimensions(buffer);
        default:
            return undefined;
    }
}

function escapeAttribute(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function wrapImageAsSvg(filePath: string, buffer: Buffer): string {
    const mime = getMimeType(filePath);
    if (!mime || mime === 'image/svg+xml') {
        throw new Error('Unsupported image format.');
    }

    const dimensions = getImageDimensions(filePath, buffer);
    const width = dimensions?.width || 1024;
    const height = dimensions?.height || 1024;
    const dataUri = `data:${mime};base64,${buffer.toString('base64')}`;

    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
        `  <image width="${width}" height="${height}" href="${escapeAttribute(dataUri)}" xlink:href="${escapeAttribute(dataUri)}" preserveAspectRatio="xMidYMid meet" />`,
        '</svg>',
        ''
    ].join('\n');
}

function loadReplacementSvg(sourcePath: string): string {
    const ext = path.extname(sourcePath).toLowerCase();
    if (ext === '.svg') {
        return fs.readFileSync(sourcePath, 'utf8');
    }

    const buffer = fs.readFileSync(sourcePath);
    return wrapImageAsSvg(sourcePath, buffer);
}

export class SvgProvider implements vscode.CustomEditorProvider<SvgDocument> {
    private readonly _onDidChangeCustomDocument =
        new vscode.EventEmitter<vscode.CustomDocumentEditEvent<SvgDocument>>();
    onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

    constructor(private readonly ctx: vscode.ExtensionContext) { }

    openCustomDocument(
        uri: vscode.Uri,
        _openContext: vscode.CustomDocumentOpenContext,
        _token: vscode.CancellationToken
    ): SvgDocument {
        return new SvgDocument(uri);
    }

    async resolveCustomEditor(
        document: SvgDocument,
        panel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.file(path.join(this.ctx.extensionPath, 'dist'))]
        };
        const filePath = document.uri.fsPath;
        let lastSelfWriteTime = 0;

        const updateContent = () => {
            const raw = fs.readFileSync(filePath, 'utf8');
            document.setContent(raw);
            void panel.webview.postMessage({ type: 'setContent', content: raw });
        };

        panel.webview.onDidReceiveMessage((msg: { type: string; content?: string }) => {
            switch (msg.type) {
                case 'save':
                    if (msg.content !== undefined) {
                        lastSelfWriteTime = Date.now();
                        fs.writeFileSync(filePath, msg.content, 'utf8');
                        document.setContent(msg.content);
                    }
                    break;
                case 'replaceAsset':
                    void (async () => {
                        const picked = await vscode.window.showOpenDialog({
                            canSelectMany: false,
                            canSelectFiles: true,
                            canSelectFolders: false,
                            openLabel: 'Replace SVG With...',
                            filters: SVG_REPLACE_FILTERS,
                            defaultUri: vscode.Uri.file(path.dirname(filePath)),
                        });

                        if (!picked?.[0]) {
                            return;
                        }

                        try {
                            const replacementContent = loadReplacementSvg(picked[0].fsPath);
                            lastSelfWriteTime = Date.now();
                            fs.writeFileSync(filePath, replacementContent, 'utf8');
                            document.setContent(replacementContent);
                            updateContent();
                            void vscode.window.showInformationMessage(
                                `Replaced ${path.basename(filePath)} with ${path.basename(picked[0].fsPath)}.`
                            );
                        } catch (error: any) {
                            void vscode.window.showErrorMessage(
                                `Failed to replace SVG: ${error?.message || 'Unknown error'}`
                            );
                        }
                    })();
                    break;
            }
        });

        const initialContent = fs.readFileSync(filePath, 'utf8');
        document.setContent(initialContent);
        panel.webview.html = buildSvgEditorPage(this.ctx.extensionPath, panel.webview, initialContent);

        const watcher = fs.watch(filePath, () => {
            if (Date.now() - lastSelfWriteTime < 500) return;
            updateContent();
        });
        panel.onDidDispose(() => watcher.close());
    }

    saveCustomDocument(
        _document: SvgDocument,
        _cancellation: vscode.CancellationToken
    ): Thenable<void> {
        return Promise.resolve();
    }

    saveCustomDocumentAs(
        document: SvgDocument,
        _destination: vscode.Uri,
        cancellation: vscode.CancellationToken
    ): Thenable<void> {
        return this.saveCustomDocument(document, cancellation);
    }

    revertCustomDocument(
        _document: SvgDocument,
        _cancellation: vscode.CancellationToken
    ): Thenable<void> {
        return Promise.resolve();
    }

    backupCustomDocument(
        _document: SvgDocument,
        context: vscode.CustomDocumentBackupContext,
        _cancellation: vscode.CancellationToken
    ): Thenable<vscode.CustomDocumentBackup> {
        return Promise.resolve({ id: context.destination.fsPath, delete: () => { } });
    }
}
