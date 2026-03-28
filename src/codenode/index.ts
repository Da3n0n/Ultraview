// Entrypoint for all code node graph logic
// This will orchestrate language-specific node detectors and graph builders

export interface CodeNode {
  id: string;
  label: string;
  type: string;
  filePath?: string;
  meta?: Record<string, unknown>;
}

export interface CodeEdge {
  source: string;
  target: string;
  kind: string;
  meta?: Record<string, unknown>;
}

export interface CodeGraph {
  nodes: CodeNode[];
  edges: CodeEdge[];
}

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { detectTs, getNamedImports } from './tsDetector';
import { detectMd } from './mdDetector';
import { detectDb } from './dbDetector';

const TYPE_NODE_TYPES = new Set(['fn', 'class', 'interface', 'type', 'enum']);

export interface StreamProgress {
  phase: 'discovering' | 'scanning' | 'linking' | 'done';
  file?: string;
  nodes: CodeNode[];
  edges: CodeEdge[];
  totalFiles?: number;
  scannedFiles?: number;
}

export async function buildCodeGraphStreaming(
  onProgress: (progress: StreamProgress) => void
): Promise<CodeGraph> {
  const wsFolders = vscode.workspace.workspaceFolders;
  if (!wsFolders || wsFolders.length === 0) {
    onProgress({ phase: 'done', nodes: [], edges: [] });
    return { nodes: [], edges: [] };
  }

  onProgress({ phase: 'discovering', nodes: [], edges: [] });

  const pattern = new vscode.RelativePattern(wsFolders[0], '**/*');
  const exclude = '{**/node_modules/**,**/dist/**,**/.git/**,**/out/**,**/.next/**,**/build/**}';
  const uris = await vscode.workspace.findFiles(pattern, exclude, 10000);
  const allFiles = new Set(uris.map(u => u.fsPath));

  const allNodes: CodeNode[] = [];
  const allEdges: CodeEdge[] = [];
  const seen = new Set<string>();
  const edgeSet = new Set<string>();

  const totalFiles = uris.length;
  let scannedFiles = 0;

  // Phase 1: Scan files incrementally
  for (const uri of uris) {
    const fp = uri.fsPath;
    const ext = path.extname(fp).toLowerCase();
    let text = '';

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

    const batchNodes: CodeNode[] = [];
    const batchEdges: CodeEdge[] = [];

    const detectorFileExts = new Set(['.ts', '.tsx', '.js', '.jsx', '.md', '.mdx', '.markdown']);
    if (!detectorFileExts.has(ext) && !seen.has(fp)) {
      const type = ext ? ext.slice(1) : baseName;
      const n: CodeNode = { id: fp, label: path.basename(fp), type, filePath: fp };
      batchNodes.push(n);
      allNodes.push(n);
      seen.add(fp);
    }

    const ts = detectTs(fp, text, allFiles);
    for (const n of ts.nodes) {
      if (!seen.has(n.id)) { batchNodes.push(n); allNodes.push(n); seen.add(n.id); }
    }
    for (const e of ts.edges) {
      const key = `${e.source}→${e.target}→${e.kind}`;
      if (!edgeSet.has(key)) { edgeSet.add(key); batchEdges.push(e); allEdges.push(e); }
    }

    const md = detectMd(fp, text, allFiles);
    for (const n of md.nodes) {
      if (!seen.has(n.id)) { batchNodes.push(n); allNodes.push(n); seen.add(n.id); }
    }
    for (const e of md.edges) {
      const key = `${e.source}→${e.target}→${e.kind}`;
      if (!edgeSet.has(key)) { edgeSet.add(key); batchEdges.push(e); allEdges.push(e); }
    }

    const db = detectDb(fp);
    for (const n of db.nodes) {
      if (!seen.has(n.id)) { batchNodes.push(n); allNodes.push(n); seen.add(n.id); }
    }
    for (const e of db.edges) {
      const key = `${e.source}→${e.target}→${e.kind}`;
      if (!edgeSet.has(key)) { edgeSet.add(key); batchEdges.push(e); allEdges.push(e); }
    }

    scannedFiles++;

    // Send batch every file that produces nodes, or every 20 files for progress
    if (batchNodes.length > 0 || batchEdges.length > 0 || scannedFiles % 20 === 0) {
      onProgress({
        phase: 'scanning',
        file: fp,
        nodes: batchNodes,
        edges: batchEdges,
        totalFiles,
        scannedFiles
      });
    }

    // Yield to event loop every 50 files to keep UI responsive
    if (scannedFiles % 50 === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  // Phase 2: Cross-file call edges
  onProgress({ phase: 'linking', nodes: [], edges: [] });

  const fileExports = new Map<string, Map<string, string>>();
  for (const node of allNodes) {
    if (TYPE_NODE_TYPES.has(node.type) && node.meta?.parent) {
      const parent = node.meta.parent as string;
      if (!fileExports.has(parent)) fileExports.set(parent, new Map());
      fileExports.get(parent)!.set(node.label, node.type);
    }
  }

  const CALL_RE = /\b(\w+)\s*\(/g;
  const callEdges: CodeEdge[] = [];

  for (const uri of uris) {
    const fp = uri.fsPath;
    const ext = path.extname(fp).toLowerCase();
    if (!['.ts', '.tsx', '.js', '.jsx'].includes(ext)) continue;
    let text2 = '';
    try { text2 = fs.readFileSync(fp, 'utf8'); } catch { continue; }

    const importedItems = getNamedImports(fp, text2, allFiles);
    for (const [local, qualifiedId] of importedItems) {
      const [srcFile, name] = qualifiedId.split('::');
      if (!fileExports.get(srcFile)?.has(name)) importedItems.delete(local);
    }
    if (importedItems.size === 0) continue;

    CALL_RE.lastIndex = 0;
    let m2: RegExpExecArray | null;
    while ((m2 = CALL_RE.exec(text2)) !== null) {
      const localName = m2[1];
      const targetId = importedItems.get(localName);
      if (!targetId) continue;
      const edgeKey = `${fp}→${targetId}→call`;
      if (!edgeSet.has(edgeKey)) {
        edgeSet.add(edgeKey);
        const e: CodeEdge = { source: fp, target: targetId, kind: 'call' };
        allEdges.push(e);
        callEdges.push(e);
      }
    }
  }

  if (callEdges.length > 0) {
    onProgress({ phase: 'linking', nodes: [], edges: callEdges });
  }

  onProgress({ phase: 'done', nodes: [], edges: [], totalFiles, scannedFiles: totalFiles });

  return { nodes: allNodes, edges: allEdges };
}

export async function buildCodeGraph(): Promise<CodeGraph> {
  const wsFolders = vscode.workspace.workspaceFolders;
  if (!wsFolders || wsFolders.length === 0) return { nodes: [], edges: [] };

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

    const detectorFileExts = new Set(['.ts', '.tsx', '.js', '.jsx', '.md', '.mdx', '.markdown']);
    if (!detectorFileExts.has(ext) && !seen.has(fp)) {
      const type = ext ? ext.slice(1) : baseName;
      nodes.push({ id: fp, label: path.basename(fp), type, filePath: fp });
      seen.add(fp);
    }

    const ts = detectTs(fp, text, allFiles);
    for (const n of ts.nodes) if (!seen.has(n.id)) { nodes.push(n); seen.add(n.id); }
    edges.push(...ts.edges);

    const md = detectMd(fp, text, allFiles);
    for (const n of md.nodes) if (!seen.has(n.id)) { nodes.push(n); seen.add(n.id); }
    edges.push(...md.edges);

    const db = detectDb(fp);
    for (const n of db.nodes) if (!seen.has(n.id)) { nodes.push(n); seen.add(n.id); }
    edges.push(...db.edges);
  }

  const edgeSet = new Set<string>();
  const dedupedEdges: CodeEdge[] = [];
  for (const e of edges) {
    const key = `${e.source}→${e.target}→${e.kind}`;
    if (!edgeSet.has(key)) { edgeSet.add(key); dedupedEdges.push(e); }
  }

  // Build file → exported names map (including all types)
  const fileExports = new Map<string, Map<string, string>>();
  for (const node of nodes) {
    if (TYPE_NODE_TYPES.has(node.type) && node.meta?.parent) {
      const parent = node.meta.parent as string;
      if (!fileExports.has(parent)) fileExports.set(parent, new Map());
      fileExports.get(parent)!.set(node.label, node.type);
    }
  }

  // Cross-file call edges for all exported types
  const CALL_RE = /\b(\w+)\s*\(/g;

  for (const uri of uris) {
    const fp = uri.fsPath;
    const ext = path.extname(fp).toLowerCase();
    if (!['.ts', '.tsx', '.js', '.jsx'].includes(ext)) continue;
    let text2 = '';
    try { text2 = fs.readFileSync(fp, 'utf8'); } catch { continue; }

    const importedItems = getNamedImports(fp, text2, allFiles);
    for (const [local, qualifiedId] of importedItems) {
      const [srcFile, name] = qualifiedId.split('::');
      if (!fileExports.get(srcFile)?.has(name)) importedItems.delete(local);
    }
    if (importedItems.size === 0) continue;

    CALL_RE.lastIndex = 0;
    let m2: RegExpExecArray | null;
    while ((m2 = CALL_RE.exec(text2)) !== null) {
      const localName = m2[1];
      const targetId = importedItems.get(localName);
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
