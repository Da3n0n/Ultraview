import * as path from 'path';
import type { CodeNode, CodeEdge } from './types';

const WIKILINK_RE = /\[\[([^\]|#]+?)(?:[|#][^\]]*)?\]\]/g;
const MDLINK_RE  = /\[(?:[^\]]*)\]\(([^)]+)\)/g;
const URL_RE = /https?:\/\/[\w\-._~:/?#[\]@!$&'()*+,;=%]+/g;

export function detectMd(filePath: string, text: string, allFiles: Set<string>): { nodes: CodeNode[]; edges: CodeEdge[] } {
  const nodes: CodeNode[] = [];
  const edges: CodeEdge[] = [];
  const ext = path.extname(filePath).toLowerCase();
  if (!['.md', '.mdx', '.markdown'].includes(ext)) return { nodes, edges };

  nodes.push({ id: filePath, label: path.basename(filePath), type: 'md', filePath });

  // [[WikiLinks]]
  WIKILINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKILINK_RE.exec(text)) !== null) {
    const name = m[1].trim();
    const lower = name.toLowerCase();
    for (const f of allFiles) {
      const base = path.basename(f, path.extname(f)).toLowerCase();
      if (base === lower) {
        edges.push({ source: filePath, target: f, kind: 'wikilink' });
        break;
      }
    }
  }

  // [text](link)
  MDLINK_RE.lastIndex = 0;
  while ((m = MDLINK_RE.exec(text)) !== null) {
    const link = m[1].trim();
    if (link.startsWith('http') || link.startsWith('#')) continue;
    const dir = path.dirname(filePath);
    const candidate = path.resolve(dir, link.split('#')[0]);
    if (allFiles.has(candidate)) {
      edges.push({ source: filePath, target: candidate, kind: 'mdlink' });
    }
  }

  // URLs
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(text)) !== null) {
    const url = m[0];
    const urlId = `url:${url}`;
    nodes.push({ id: urlId, label: url, type: 'url', meta: { url } });
    edges.push({ source: filePath, target: urlId, kind: 'url' });
  }

  return { nodes, edges };
}
