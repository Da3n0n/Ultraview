// Entrypoint for all code node graph logic
// This will orchestrate language-specific node detectors and graph builders

export type { CodeNode, CodeEdge, CodeGraph, StreamProgress } from './types';

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { CodeNode, CodeEdge, CodeGraph, StreamProgress } from './types';
import {
  detectTs,
  getNamedImports,
  getAllFunctionsWithIndex
} from './tsDetector';
import { detectMd } from './mdDetector';
import { detectDb } from './dbDetector';

function buildExportTargets(nodes: CodeNode[]): Map<string, Map<string, string>> {
  const fileExports = new Map<string, Map<string, string>>();
  for (const node of nodes) {
    if (!node.filePath || !node.meta?.parent) continue;
    const parent = node.meta.parent as string;
    const exportedMembers = Array.isArray(node.meta.exportedMembers)
      ? node.meta.exportedMembers.filter((value): value is string => typeof value === 'string')
      : [];
    if (exportedMembers.length === 0) continue;
    if (!fileExports.has(parent)) fileExports.set(parent, new Map());
    for (const name of exportedMembers) {
      fileExports.get(parent)!.set(name, node.id);
    }
  }
  return fileExports;
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

  const fileExports = buildExportTargets(allNodes);
  const fileFunctionGroups = new Map<string, string>();
  for (const node of allNodes) {
    if (node.type === 'fn' && node.filePath) fileFunctionGroups.set(node.filePath, node.id);
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

    const localFns = getAllFunctionsWithIndex(text2);

    CALL_RE.lastIndex = 0;
    let m2: RegExpExecArray | null;
    while ((m2 = CALL_RE.exec(text2)) !== null) {
      const localName = m2[1];
      const qualifiedId = importedItems.get(localName);
      if (!qualifiedId) continue;
      const [srcFile, importedName] = qualifiedId.split('::');
      const targetId = fileExports.get(srcFile)?.get(importedName);
      if (!targetId) continue;
      
      let callerName: string | null = null;
      for (let i = localFns.length - 1; i >= 0; i--) {
        if (localFns[i].index < m2.index) {
          callerName = localFns[i].name;
          break;
        }
      }
      
      const sourceId = callerName ? (fileFunctionGroups.get(fp) ?? fp) : fp;
      const edgeKey = `${sourceId}→${targetId}→call`;
      if (!edgeSet.has(edgeKey)) {
        edgeSet.add(edgeKey);
        const e: CodeEdge = { source: sourceId, target: targetId, kind: 'call' };
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
  const fileExports = buildExportTargets(nodes);
  const fileFunctionGroups = new Map<string, string>();
  for (const node of nodes) {
    if (node.type === 'fn' && node.filePath) fileFunctionGroups.set(node.filePath, node.id);
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

    const localFns = getAllFunctionsWithIndex(text2);

    CALL_RE.lastIndex = 0;
    let m2: RegExpExecArray | null;
    while ((m2 = CALL_RE.exec(text2)) !== null) {
      const localName = m2[1];
      const qualifiedId = importedItems.get(localName);
      if (!qualifiedId) continue;
      const [srcFile, importedName] = qualifiedId.split('::');
      const targetId = fileExports.get(srcFile)?.get(importedName);
      if (!targetId) continue;
      
      let callerName: string | null = null;
      for (let i = localFns.length - 1; i >= 0; i--) {
        if (localFns[i].index < m2.index) {
          callerName = localFns[i].name;
          break;
        }
      }
      
      const sourceId = callerName ? (fileFunctionGroups.get(fp) ?? fp) : fp;
      const edgeKey = `${sourceId}→${targetId}→call`;
      if (!edgeSet.has(edgeKey)) {
        edgeSet.add(edgeKey);
        dedupedEdges.push({ source: sourceId, target: targetId, kind: 'call' });
      }
    }
  }

  return { nodes, edges: dedupedEdges };
}
