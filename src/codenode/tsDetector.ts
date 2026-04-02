import * as path from 'path';
import type { CodeNode, CodeEdge } from './types';

const IMPORT_RE = /(?:import|require)\s*(?:[^'"]*from\s*)?['"]([^'"]+)['"]/g;
// Named imports: import { foo, bar as baz } from './path'
const NAMED_IMPORT_RE = /import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g;
// Function declarations (exported and non-exported)
const FN_RE = /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g;
// Class declarations
const CLASS_RE = /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/g;
// Interface declarations
const INTERFACE_RE = /(?:export\s+)?interface\s+(\w+)/g;
// Type alias declarations
const TYPE_RE = /(?:export\s+)?type\s+(\w+)\s*=/g;
// Enum declarations
const ENUM_RE = /(?:export\s+)?(?:const\s+)?enum\s+(\w+)/g;
// Arrow functions and const declarations (exported and non-exported)
const CONST_RE = /(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?(?:\(|function\b)/g;
// URL detection
const URL_RE = /https?:\/\/[\w\-._~:/?#[\]@!$&'()*+,;=%]+/g;

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

  // Function declarations
  FN_RE.lastIndex = 0;
  while ((m = FN_RE.exec(text)) !== null) {
    const name = m[1];
    if (!name) continue;
    const id = `${filePath}::${name}`;
    const line = text.substring(0, m.index).split('\n').length;
    nodes.push({ id, label: name, type: 'fn', filePath, meta: { parent: filePath, line } });
    edges.push({ source: filePath, target: id, kind: 'declares' });
  }

  // Class declarations
  CLASS_RE.lastIndex = 0;
  while ((m = CLASS_RE.exec(text)) !== null) {
    const name = m[1];
    if (!name) continue;
    const id = `${filePath}::${name}`;
    const line = text.substring(0, m.index).split('\n').length;
    nodes.push({ id, label: name, type: 'class', filePath, meta: { parent: filePath, line } });
    edges.push({ source: filePath, target: id, kind: 'declares' });
  }

  // Interface declarations
  INTERFACE_RE.lastIndex = 0;
  while ((m = INTERFACE_RE.exec(text)) !== null) {
    const name = m[1];
    if (!name) continue;
    const id = `${filePath}::${name}`;
    const line = text.substring(0, m.index).split('\n').length;
    nodes.push({ id, label: name, type: 'interface', filePath, meta: { parent: filePath, line } });
    edges.push({ source: filePath, target: id, kind: 'declares' });
  }

  // Type alias declarations
  TYPE_RE.lastIndex = 0;
  while ((m = TYPE_RE.exec(text)) !== null) {
    const name = m[1];
    if (!name) continue;
    const id = `${filePath}::${name}`;
    const line = text.substring(0, m.index).split('\n').length;
    nodes.push({ id, label: name, type: 'type', filePath, meta: { parent: filePath, line } });
    edges.push({ source: filePath, target: id, kind: 'declares' });
  }

  // Enum declarations
  ENUM_RE.lastIndex = 0;
  while ((m = ENUM_RE.exec(text)) !== null) {
    const name = m[1];
    if (!name) continue;
    const id = `${filePath}::${name}`;
    const line = text.substring(0, m.index).split('\n').length;
    nodes.push({ id, label: name, type: 'enum', filePath, meta: { parent: filePath, line } });
    edges.push({ source: filePath, target: id, kind: 'declares' });
  }

  // Const/arrow function declarations
  CONST_RE.lastIndex = 0;
  while ((m = CONST_RE.exec(text)) !== null) {
    const name = m[1];
    if (!name) continue;
    const id = `${filePath}::${name}`;
    const line = text.substring(0, m.index).split('\n').length;
    nodes.push({ id, label: name, type: 'fn', filePath, meta: { parent: filePath, line } });
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
      const parts = part.trim().split(/\s+as\s+/);
      const exportedName = parts[0].trim();
      const localName = (parts[1] ?? parts[0]).trim();
      if (exportedName && localName) result.set(localName, `${sourceFile}::${exportedName}`);
    }
  }
  return result;
}

export function getAllExports(
  filePath: string,
  text: string
): { name: string; type: string }[] {
  const exports: { name: string; type: string }[] = [];
  
  const fnRe = /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = fnRe.exec(text)) !== null) {
    if (m[1]) exports.push({ name: m[1], type: 'fn' });
  }

  const classRe = /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/g;
  while ((m = classRe.exec(text)) !== null) {
    if (m[1]) exports.push({ name: m[1], type: 'class' });
  }

  const interfaceRe = /(?:export\s+)?interface\s+(\w+)/g;
  while ((m = interfaceRe.exec(text)) !== null) {
    if (m[1]) exports.push({ name: m[1], type: 'interface' });
  }

  const typeRe = /(?:export\s+)?type\s+(\w+)\s*=/g;
  while ((m = typeRe.exec(text)) !== null) {
    if (m[1]) exports.push({ name: m[1], type: 'type' });
  }

  const enumRe = /(?:export\s+)?(?:const\s+)?enum\s+(\w+)/g;
  while ((m = enumRe.exec(text)) !== null) {
    if (m[1]) exports.push({ name: m[1], type: 'enum' });
  }

  const constRe = /(?:export\s+)?const\s+(\w+)\s*=/g;
  while ((m = constRe.exec(text)) !== null) {
    if (m[1]) exports.push({ name: m[1], type: 'const' });
  }

  return exports;
}

export function getAllFunctionsWithIndex(text: string): { name: string; index: number }[] {
  const fns: { name: string; index: number }[] = [];
  const fnRe = /(?:export\s+)?(?:async\s+)?(?:function|class)\s+(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = fnRe.exec(text)) !== null) {
    if (m[1]) fns.push({ name: m[1], index: m.index });
  }
  const constRe = /(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?(?:\(|function\b)/g;
  while ((m = constRe.exec(text)) !== null) {
    if (m[1]) fns.push({ name: m[1], index: m.index });
  }
  // Sort by index so we can binary search or linear search
  fns.sort((a, b) => a.index - b.index);
  return fns;
}
