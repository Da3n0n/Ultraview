import * as path from 'path';
import type { CodeNode, CodeEdge } from './types';

const IMPORT_RE = /(?:import|require)\s*(?:[^'"]*from\s*)?['"]([^'"]+)['"]/g;
const NAMED_IMPORT_RE = /import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g;
const FN_RE = /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g;
const CLASS_RE = /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/g;
const INTERFACE_RE = /(?:export\s+)?interface\s+(\w+)/g;
const TYPE_RE = /(?:export\s+)?type\s+(\w+)\s*=/g;
const ENUM_RE = /(?:export\s+)?(?:const\s+)?enum\s+(\w+)/g;
const CONST_RE = /(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?(?:\(|function\b)/g;
const VAR_RE = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g;
const IDENT_RE = /\b[A-Za-z_$][\w$]*\b/g;
const URL_RE = /https?:\/\/[\w\-._~:/?#[\]@!$&'()*+,;=%]+/g;
const EXPORT_LINE_RE = /export\s+(?:async\s+)?(?:function|class|interface|type|const\s+|(?:const\s+)?enum\s+)(\w+)/g;

type InterfaceMemberKind = 'interface' | 'type' | 'enum';

interface SnippetMember {
  name: string;
  line: number;
  snippet: string;
}

interface InterfaceSnippetMember extends SnippetMember {
  kind: InterfaceMemberKind;
}

interface VariableControl {
  name: string;
  controlType: 'color' | 'range' | 'toggle' | 'text';
  value: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
  quote?: string;
}

interface VariableSnippetMember extends SnippetMember {
  control?: VariableControl;
}

export function getFunctionGroupId(filePath: string): string {
  return `${filePath}::group:functions`;
}

export function getInterfaceGroupId(filePath: string): string {
  return `${filePath}::group:interfaces`;
}

export function getImportGroupId(filePath: string): string {
  return `${filePath}::group:imports`;
}

export function getExportGroupId(filePath: string): string {
  return `${filePath}::group:exports`;
}

export function getVariableGroupId(filePath: string): string {
  return `${filePath}::group:variables`;
}

interface FunctionScope {
  start: number;
  end: number;
}

function stripStringsAndComments(line: string): string {
  let result = '';
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let escaped = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];

    if (!inSingle && !inDouble && !inTemplate && ch === '/' && next === '/') break;

    if (escaped) {
      escaped = false;
      result += ' ';
      continue;
    }

    if (ch === '\\') {
      escaped = true;
      result += ' ';
      continue;
    }

    if (!inDouble && !inTemplate && ch === '\'') {
      inSingle = !inSingle;
      result += ' ';
      continue;
    }
    if (!inSingle && !inTemplate && ch === '"') {
      inDouble = !inDouble;
      result += ' ';
      continue;
    }
    if (!inSingle && !inDouble && ch === '`') {
      inTemplate = !inTemplate;
      result += ' ';
      continue;
    }

    result += inSingle || inDouble || inTemplate ? ' ' : ch;
  }

  return result;
}

function countChar(text: string, ch: string): number {
  return Array.from(text).filter(c => c === ch).length;
}

function extractCodeUnitSnippet(lines: string[], declarationLine: number): string {
  const startIndex = Math.max(0, declarationLine - 1);
  const maxLines = Math.min(lines.length, startIndex + 60);
  const snippetLines: string[] = [];
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let sawContent = false;
  let sawBlock = false;

  for (let i = startIndex; i < maxLines; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();
    const cleanLine = stripStringsAndComments(rawLine);

    snippetLines.push(rawLine.trimEnd());

    if (trimmed.length > 0) sawContent = true;
    if (cleanLine.includes('{')) sawBlock = true;

    braceDepth += countChar(cleanLine, '{') - countChar(cleanLine, '}');
    parenDepth += countChar(cleanLine, '(') - countChar(cleanLine, ')');
    bracketDepth += countChar(cleanLine, '[') - countChar(cleanLine, ']');

    if (i === startIndex) continue;

    if (sawBlock && braceDepth <= 0 && parenDepth <= 0 && bracketDepth <= 0) break;
    if (!sawBlock && sawContent && braceDepth <= 0 && parenDepth <= 0 && bracketDepth <= 0) {
      if (/[;}]$/.test(trimmed) || trimmed.length === 0) break;
    }
  }

  return snippetLines.join('\n').trim();
}

function joinGroupSnippets(snippets: string[]): string {
  return snippets.filter(Boolean).join('\n\n').trim();
}

function findBlockEnd(text: string, openBraceIndex: number): number {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;

  for (let i = openBraceIndex; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (!inSingle && !inDouble && !inTemplate && ch === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (!inSingle && !inDouble && !inTemplate && ch === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    if (!inDouble && !inTemplate && ch === '\'') {
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle && !inTemplate && ch === '"') {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble && ch === '`') {
      inTemplate = !inTemplate;
      continue;
    }
    if (inSingle || inDouble || inTemplate) continue;

    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }

  return text.length - 1;
}

function getFunctionScopes(text: string): FunctionScope[] {
  const scopes: FunctionScope[] = [];
  const patterns = [FN_RE, CLASS_RE, CONST_RE];

  for (const re of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const openBraceIndex = text.indexOf('{', m.index);
      if (openBraceIndex < 0) continue;
      scopes.push({ start: m.index, end: findBlockEnd(text, openBraceIndex) });
    }
  }

  return scopes.sort((a, b) => a.start - b.start);
}

function inferVariableControl(name: string, initializer: string): VariableControl | undefined {
  const value = initializer.trim().replace(/,$/, '');
  if (/^['"]#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})['"]$/i.test(value)) {
    return { name, controlType: 'color', value: value.slice(1, -1), quote: value[0] };
  }
  if (/^(true|false)$/.test(value)) {
    return { name, controlType: 'toggle', value: value === 'true' };
  }
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    const numericValue = Number(value);
    const span = Math.max(Math.abs(numericValue), 10);
    return {
      name,
      controlType: 'range',
      value: numericValue,
      min: Math.floor(numericValue - span),
      max: Math.ceil(numericValue + span),
      step: Number.isInteger(numericValue) ? 1 : 0.1
    };
  }
  if (/^['"].*['"]$/.test(value)) {
    return { name, controlType: 'text', value: value.slice(1, -1), quote: value[0] };
  }
  return undefined;
}

export function detectTs(filePath: string, text: string, allFiles: Set<string>): { nodes: CodeNode[]; edges: CodeEdge[] } {
  const nodes: CodeNode[] = [];
  const edges: CodeEdge[] = [];
  const ext = path.extname(filePath).toLowerCase();
  if (!['.ts', '.tsx', '.js', '.jsx'].includes(ext)) return { nodes, edges };

  nodes.push({ id: filePath, label: path.basename(filePath), type: ext.slice(1), filePath });
  const lines = text.replace(/\r\n/g, '\n').split('\n');

  const exportedNames = new Set(getAllExports(filePath, text).map(item => item.name));
  const functionScopes = getFunctionScopes(text);
  const fnMembers: SnippetMember[] = [];
  const interfaceMembers: InterfaceSnippetMember[] = [];
  const importMembers: SnippetMember[] = [];
  const exportMembers: SnippetMember[] = [];
  const variableMembers: VariableSnippetMember[] = [];
  const seenFnMembers = new Set<string>();
  const seenInterfaceMembers = new Set<string>();
  const seenImportMembers = new Set<string>();
  const seenExportMembers = new Set<string>();
  const seenVariableMembers = new Set<string>();

  const addFnMember = (name: string, line: number) => {
    if (!name || seenFnMembers.has(name)) return;
    seenFnMembers.add(name);
    fnMembers.push({ name, line, snippet: extractCodeUnitSnippet(lines, line) });
  };

  const addInterfaceMember = (name: string, line: number, kind: InterfaceMemberKind) => {
    if (!name || seenInterfaceMembers.has(name)) return;
    seenInterfaceMembers.add(name);
    interfaceMembers.push({ name, line, kind, snippet: extractCodeUnitSnippet(lines, line) });
  };

  const addImportMember = (name: string, line: number) => {
    const key = `${name}:${line}`;
    if (seenImportMembers.has(key)) return;
    seenImportMembers.add(key);
    importMembers.push({ name, line, snippet: extractCodeUnitSnippet(lines, line) });
  };

  const addExportMember = (name: string, line: number) => {
    if (!name || seenExportMembers.has(name)) return;
    seenExportMembers.add(name);
    exportMembers.push({ name, line, snippet: extractCodeUnitSnippet(lines, line) });
  };

  const addVariableMember = (name: string, line: number, initializer: string) => {
    if (!name || seenVariableMembers.has(name) || seenFnMembers.has(name) || seenInterfaceMembers.has(name)) return;
    seenVariableMembers.add(name);
    variableMembers.push({
      name,
      line,
      snippet: extractCodeUnitSnippet(lines, line),
      control: inferVariableControl(name, initializer)
    });
  };

  IMPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMPORT_RE.exec(text)) !== null) {
    const imp = m[1];
    if (!imp.startsWith('.')) continue;
    const dir = path.dirname(filePath);
    const base = path.resolve(dir, imp);
    const line = text.substring(0, m.index).split('\n').length;
    addImportMember(imp, line);
    for (const ext2 of ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js']) {
      const candidate = base + ext2;
      if (allFiles.has(candidate)) {
        edges.push({ source: getImportGroupId(filePath), target: candidate, kind: 'import' });
        break;
      }
    }
  }

  FN_RE.lastIndex = 0;
  while ((m = FN_RE.exec(text)) !== null) {
    if (m[1]) addFnMember(m[1], text.substring(0, m.index).split('\n').length);
  }

  CLASS_RE.lastIndex = 0;
  while ((m = CLASS_RE.exec(text)) !== null) {
    if (m[1]) addFnMember(m[1], text.substring(0, m.index).split('\n').length);
  }

  INTERFACE_RE.lastIndex = 0;
  while ((m = INTERFACE_RE.exec(text)) !== null) {
    if (m[1]) addInterfaceMember(m[1], text.substring(0, m.index).split('\n').length, 'interface');
  }

  TYPE_RE.lastIndex = 0;
  while ((m = TYPE_RE.exec(text)) !== null) {
    if (m[1]) addInterfaceMember(m[1], text.substring(0, m.index).split('\n').length, 'type');
  }

  ENUM_RE.lastIndex = 0;
  while ((m = ENUM_RE.exec(text)) !== null) {
    if (m[1]) addInterfaceMember(m[1], text.substring(0, m.index).split('\n').length, 'enum');
  }

  CONST_RE.lastIndex = 0;
  while ((m = CONST_RE.exec(text)) !== null) {
    if (m[1]) addFnMember(m[1], text.substring(0, m.index).split('\n').length);
  }

  VAR_RE.lastIndex = 0;
  while ((m = VAR_RE.exec(text)) !== null) {
    if (m[1]) addVariableMember(m[1], text.substring(0, m.index).split('\n').length, m[2] ?? '');
  }

  EXPORT_LINE_RE.lastIndex = 0;
  while ((m = EXPORT_LINE_RE.exec(text)) !== null) {
    if (m[1]) addExportMember(m[1], text.substring(0, m.index).split('\n').length);
  }

  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(text)) !== null) {
    const url = m[0];
    const urlId = `url:${url}`;
    nodes.push({ id: urlId, label: url, type: 'url', meta: { url } });
    edges.push({ source: filePath, target: urlId, kind: 'url' });
  }

  if (importMembers.length > 0) {
    nodes.push({
      id: getImportGroupId(filePath),
      label: `Imports (${importMembers.length})`,
      type: 'import',
      filePath,
      meta: {
        parent: filePath,
        line: Math.min(...importMembers.map(member => member.line)),
        members: importMembers.map(member => member.name),
        snippet: joinGroupSnippets(importMembers.map(member => member.snippet))
      }
    });
    edges.push({ source: filePath, target: getImportGroupId(filePath), kind: 'declares' });
  }

  if (fnMembers.length > 0) {
    nodes.push({
      id: getFunctionGroupId(filePath),
      label: `Functions (${fnMembers.length})`,
      type: 'fn',
      filePath,
      meta: {
        parent: filePath,
        line: Math.min(...fnMembers.map(member => member.line)),
        members: fnMembers.map(member => member.name),
        exportedMembers: fnMembers.filter(member => exportedNames.has(member.name)).map(member => member.name),
        snippet: joinGroupSnippets(fnMembers.map(member => member.snippet))
      }
    });
    edges.push({ source: filePath, target: getFunctionGroupId(filePath), kind: 'declares' });
  }

  if (interfaceMembers.length > 0) {
    nodes.push({
      id: getInterfaceGroupId(filePath),
      label: `Interfaces (${interfaceMembers.length})`,
      type: 'interface',
      filePath,
      meta: {
        parent: filePath,
        line: Math.min(...interfaceMembers.map(member => member.line)),
        members: interfaceMembers.map(member => member.name),
        memberKinds: interfaceMembers.map(member => member.kind),
        exportedMembers: interfaceMembers.filter(member => exportedNames.has(member.name)).map(member => member.name),
        snippet: joinGroupSnippets(interfaceMembers.map(member => member.snippet))
      }
    });
    edges.push({ source: filePath, target: getInterfaceGroupId(filePath), kind: 'declares' });
  }

  if (variableMembers.length > 0) {
    nodes.push({
      id: getVariableGroupId(filePath),
      label: `Variables (${variableMembers.length})`,
      type: 'const',
      filePath,
      meta: {
        parent: filePath,
        line: Math.min(...variableMembers.map(member => member.line)),
        members: variableMembers.map(member => member.name),
        controls: variableMembers
          .filter((member): member is VariableSnippetMember & { control: VariableControl } => Boolean(member.control))
          .map(member => member.control),
        exportedMembers: variableMembers.filter(member => exportedNames.has(member.name)).map(member => member.name),
        snippet: joinGroupSnippets(variableMembers.map(member => member.snippet))
      }
    });
    edges.push({ source: filePath, target: getVariableGroupId(filePath), kind: 'declares' });
  }

  if (exportMembers.length > 0) {
    nodes.push({
      id: getExportGroupId(filePath),
      label: `Exports (${exportMembers.length})`,
      type: 'export',
      filePath,
      meta: {
        parent: filePath,
        line: Math.min(...exportMembers.map(member => member.line)),
        members: exportMembers.map(member => member.name),
        exportedMembers: exportMembers.map(member => member.name),
        snippet: joinGroupSnippets(exportMembers.map(member => member.snippet))
      }
    });
    edges.push({ source: filePath, target: getExportGroupId(filePath), kind: 'declares' });
    if (fnMembers.some(member => exportedNames.has(member.name))) {
      edges.push({ source: getFunctionGroupId(filePath), target: getExportGroupId(filePath), kind: 'export' });
    }
    if (interfaceMembers.some(member => exportedNames.has(member.name))) {
      edges.push({ source: getInterfaceGroupId(filePath), target: getExportGroupId(filePath), kind: 'export' });
    }
    if (variableMembers.some(member => exportedNames.has(member.name))) {
      edges.push({ source: getVariableGroupId(filePath), target: getExportGroupId(filePath), kind: 'export' });
    }
  }

  if (fnMembers.length > 0 && variableMembers.length > 0) {
    const variableNames = new Set(variableMembers.map(member => member.name));
    let usesVariables = false;

    for (const scope of functionScopes) {
      const body = text.slice(scope.start, scope.end + 1);
      IDENT_RE.lastIndex = 0;
      let bodyMatch: RegExpExecArray | null;
      while ((bodyMatch = IDENT_RE.exec(body)) !== null) {
        if (variableNames.has(bodyMatch[0])) {
          usesVariables = true;
          break;
        }
      }
      if (usesVariables) break;
    }

    if (usesVariables) {
      edges.push({ source: getFunctionGroupId(filePath), target: getVariableGroupId(filePath), kind: 'use' });
    }
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
      if (allFiles.has(candidate)) {
        sourceFile = candidate;
        break;
      }
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
  void filePath;
  const exports: { name: string; type: string }[] = [];

  const fnRe = /export\s+(?:async\s+)?function\s+(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = fnRe.exec(text)) !== null) {
    if (m[1]) exports.push({ name: m[1], type: 'fn' });
  }

  const classRe = /export\s+(?:abstract\s+)?class\s+(\w+)/g;
  while ((m = classRe.exec(text)) !== null) {
    if (m[1]) exports.push({ name: m[1], type: 'class' });
  }

  const interfaceRe = /export\s+interface\s+(\w+)/g;
  while ((m = interfaceRe.exec(text)) !== null) {
    if (m[1]) exports.push({ name: m[1], type: 'interface' });
  }

  const typeRe = /export\s+type\s+(\w+)\s*=/g;
  while ((m = typeRe.exec(text)) !== null) {
    if (m[1]) exports.push({ name: m[1], type: 'type' });
  }

  const enumRe = /export\s+(?:const\s+)?enum\s+(\w+)/g;
  while ((m = enumRe.exec(text)) !== null) {
    if (m[1]) exports.push({ name: m[1], type: 'enum' });
  }

  const constRe = /export\s+const\s+(\w+)\s*=/g;
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
  fns.sort((a, b) => a.index - b.index);
  return fns;
}
