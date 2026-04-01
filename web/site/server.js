import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, extname } from 'node:path';

const PORT = process.env.PORT || 3000;
const DIST_DIR = join(process.cwd(), 'dist');

const MIME_TYPES = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
};

const server = createServer((req, res) => {
    let filePath = join(DIST_DIR, req.url === '/' ? 'index.html' : req.url);
    const ext = extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    try {
        const content = readFileSync(filePath);
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
    } catch {
        if (req.url !== '/') {
            try {
                const content = readFileSync(join(DIST_DIR, 'index.html'));
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(content);
            } catch {
                res.writeHead(404);
                res.end('Not Found');
            }
        } else {
            res.writeHead(404);
            res.end('Not Found');
        }
    }
});

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
