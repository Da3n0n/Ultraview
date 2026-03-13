import * as fs from 'fs';
import * as path from 'path';
import { CodeNode, CodeEdge } from './index';

const IMPORT_RE = /(?:import|require)\s*(?:[^'"]*from\s*)?['"]([^'"]+)['"]/g;
// Matches exported AND non-exported top-level functions, classes, and arrow-function consts
const FN_RE = /(?:export\s+)?(?:async\s+)?(?:function|class)\s+(\w+)|(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?(?:\(|function\b)/g;
const URL_RE = /https?:\/\/[\w\-._~:/?#[\]@!$&'()*+,;=%]+/g;
// Named imports: import { foo, bar as baz } from './path'
const NAMED_IMPORT_RE = /import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g;

export function detectTs(filePath: string, text: string, allFiles: Set<string>): { nodes: CodeNode[]; edges: CodeEdge[] } {
  const nodes: CodeNode[] = [];
  const edges: CodeEdge[] = [];
  const ext = path.extname(filePath).toLowerCase();
  if (!['.ts', '.tsx', '.js', '.jsx'].includes(ext)) return { nodes, edges };

  // File node
  nodes.push({ id: filePath, label: path.basename(filePath), type: ext.slice(1), filePath });

  // Imports
  IMPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMPORT_RE.exec(text)) !== null) {
    const imp = m[1];
    if (imp.startsWith('.')) {
      const dir = path.dirname(filePath);
      const base = path.resolve(dir, imp);
      for (const ext2 of ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js']) {
        const candidate = base + ext2;
        if (allFiles.has(candidate)) {
          edges.push({ source: filePath, target: candidate, kind: 'import' });
          break;
        }
      }
    }
  }

  // Functions/classes
  FN_RE.lastIndex = 0;
  while ((m = FN_RE.exec(text)) !== null) {
    const name = m[1] ?? m[2];
    if (!name) continue;
    const id = `${filePath}::${name}`;
    nodes.push({ id, label: name, type: 'fn', filePath, meta: { parent: filePath } });
    edges.push({ source: filePath, target: id, kind: 'declares' });
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

/**
 * Returns a map of localName → resolvedSourceFilePath for named imports in a TS/JS file.
 * Used by buildCodeGraph for cross-file call-edge detection.
 */
export function getNamedImports(
  filePath: string,
  text: string,
  allFiles: Set<string>
): Map<string, string> {
  const result = new Map<string, string>();
  const ext = path.extname(filePath).toLowerCase();
  if (!['.ts', '.tsx', '.js', '.jsx'].includes(ext)) return result;

  NAMED_IMPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NAMED_IMPORT_RE.exec(text)) !== null) {
    const importPath = m[2];
    if (!importPath.startsWith('.')) continue;
    const dir = path.dirname(filePath);
    const base = path.resolve(dir, importPath);
    let sourceFile: string | null = null;
    for (const ext2 of ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js']) {
      const candidate = base + ext2;
      if (allFiles.has(candidate)) { sourceFile = candidate; break; }
    }
    if (!sourceFile) continue;
    for (const part of m[1].split(',')) {
      // handle "foo as bar" → use original name "foo" to match export, map to local name "bar"
      const parts = part.trim().split(/\s+as\s+/);
      const exportedName = parts[0].trim();
      const localName = (parts[1] ?? parts[0]).trim();
      if (exportedName && localName) result.set(localName, `${sourceFile}::${exportedName}`);
    }
  }
  return result;
}
