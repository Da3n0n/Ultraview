// Entrypoint for all code node graph logic
// This will orchestrate language-specific node detectors and graph builders

export interface CodeNode {
  id: string;
  label: string;
  type: string; // e.g. 'ts', 'py', 'md', 'sql', 'url', 'db', etc.
  filePath?: string;
  meta?: Record<string, unknown>;
}

export interface CodeEdge {
  source: string;
  target: string;
  kind: string; // e.g. 'import', 'call', 'link', 'db', 'url', etc.
  meta?: Record<string, unknown>;
}

export interface CodeGraph {
  nodes: CodeNode[];
  edges: CodeEdge[];
}

// Main entrypoint: scan workspace and build a graph
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { detectTs, getNamedImports } from './tsDetector';
import { detectMd } from './mdDetector';
import { detectDb } from './dbDetector';

export async function buildCodeGraph(): Promise<CodeGraph> {
  const wsFolders = vscode.workspace.workspaceFolders;
  if (!wsFolders || wsFolders.length === 0) return { nodes: [], edges: [] };

  // Find all files (code, markdown, db)
  const pattern = new vscode.RelativePattern(wsFolders[0], '**/*');
  const exclude = '{**/node_modules/**,**/dist/**,**/.git/**,**/out/**,**/.next/**,**/build/**}';
  const uris = await vscode.workspace.findFiles(pattern, exclude, 10000);
  const allFiles = new Set(uris.map(u => u.fsPath));

  const nodes: CodeNode[] = [];
  const edges: CodeEdge[] = [];
  const seen = new Set<string>();

  for (const uri of uris) {
    const fp = uri.fsPath;
    const ext = path.extname(fp).toLowerCase();
    let text = '';

    // Expand readable/text extensions so we can run detectors on more languages
    const readableExts = [
      '.ts', '.tsx', '.js', '.jsx',
      '.md', '.mdx', '.markdown',
      '.sql', '.json', '.yaml', '.yml', '.py', '.sh', '.bat', '.ps1', '.toml', '.ini', '.env', '.txt',
      '.go', '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.java', '.rs', '.php', '.cs', '.html', '.htm', '.css', '.xml'
    ];

    const baseName = path.basename(fp).toLowerCase();
    if (readableExts.includes(ext) || ['dockerfile', 'makefile', 'cmakelists.txt'].includes(baseName)) {
      try { text = fs.readFileSync(fp, 'utf8'); } catch {}
    }

    // Ensure every file becomes at least one node so "all nodes show up for every language"
    // We only add a generic file node when a specialized detector will not create it.
    const detectorFileExts = new Set(['.ts', '.tsx', '.js', '.jsx', '.md', '.mdx', '.markdown']);
    if (!detectorFileExts.has(ext) && !seen.has(fp)) {
      const type = ext ? ext.slice(1) : baseName; // use extension or basename for files like Dockerfile
      nodes.push({ id: fp, label: path.basename(fp), type, filePath: fp });
      seen.add(fp);
    }

    // TypeScript/JS detector (will add its own file node for JS/TS files)
    const ts = detectTs(fp, text, allFiles);
    for (const n of ts.nodes) if (!seen.has(n.id)) { nodes.push(n); seen.add(n.id); }
    edges.push(...ts.edges);

    // Markdown
    const md = detectMd(fp, text, allFiles);
    for (const n of md.nodes) if (!seen.has(n.id)) { nodes.push(n); seen.add(n.id); }
    edges.push(...md.edges);

    // DB
    const db = detectDb(fp);
    for (const n of db.nodes) if (!seen.has(n.id)) { nodes.push(n); seen.add(n.id); }
    edges.push(...db.edges);
  }

  // TODO: add more detectors (Python, SQL, config, etc)

  // Deduplicate edges
  const edgeSet = new Set<string>();
  const dedupedEdges: CodeEdge[] = [];
  for (const e of edges) {
    const key = `${e.source}→${e.target}→${e.kind}`;
    if (!edgeSet.has(key)) { edgeSet.add(key); dedupedEdges.push(e); }
  }

  // ── Second pass: cross-file function-call edges ──────────────────────────
  // Build a map: fn nodeId (file::name) → exists, plus file → exported fn names
  const fileExports = new Map<string, Set<string>>();
  for (const node of nodes) {
    if (node.type === 'fn' && node.meta?.parent) {
      const parent = node.meta.parent as string;
      if (!fileExports.has(parent)) fileExports.set(parent, new Set());
      fileExports.get(parent)!.add(node.label);
    }
  }

  const CALL_RE = /\b(\w+)\s*\(/g;

  for (const uri of uris) {
    const fp = uri.fsPath;
    const ext = path.extname(fp).toLowerCase();
    if (!['.ts', '.tsx', '.js', '.jsx'].includes(ext)) continue;
    let text2 = '';
    try { text2 = fs.readFileSync(fp, 'utf8'); } catch { continue; }

    // Map localName → `sourceFile::exportedName`
    const importedFns = getNamedImports(fp, text2, allFiles);
    // Keep only names that correspond to actual fn nodes
    for (const [local, qualifiedId] of importedFns) {
      const [srcFile, fnName] = qualifiedId.split('::');
      if (!fileExports.get(srcFile)?.has(fnName)) importedFns.delete(local);
    }
    if (importedFns.size === 0) continue;

    CALL_RE.lastIndex = 0;
    let m2: RegExpExecArray | null;
    while ((m2 = CALL_RE.exec(text2)) !== null) {
      const localName = m2[1];
      const targetId = importedFns.get(localName);
      if (!targetId) continue;
      const edgeKey = `${fp}→${targetId}→call`;
      if (!edgeSet.has(edgeKey)) {
        edgeSet.add(edgeKey);
        dedupedEdges.push({ source: fp, target: targetId, kind: 'call' });
      }
    }
  }

  return { nodes, edges: dedupedEdges };
}
