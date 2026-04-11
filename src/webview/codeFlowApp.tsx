import React, { useCallback, useEffect, useState, useMemo, useRef, type FC } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ReactFlow,
  Background,
  useNodesState,
  useEdgesState,
  BackgroundVariant,
  Panel,
  useReactFlow,
  ReactFlowProvider,
  Handle,
  Position,
  NodeResizer,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { ReactNode } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface CodeNode {
  id: string;
  label: string;
  type: string;
  filePath?: string;
  meta?: Record<string, unknown>;
  parentId?: string;
}

interface CodeEdge {
  source: string;
  target: string;
  kind: string;
  meta?: Record<string, unknown>;
}

interface LogEntry {
  text: string;
  type: 'file' | 'phase' | 'node' | 'info';
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TYPE_COLORS: Record<string, string> = {
  ts: '#4EC9B0', js: '#F0DB4F', md: '#C586C0', fn: '#DCDCAA', url: '#569CD6',
  db: '#CE9178', py: '#3572A5', rs: '#DEA584', go: '#00ADD8', cpp: '#F34B7D',
  c: '#A97BFF', cs: '#178600', java: '#B07219', class: '#4EC9B0',
  interface: '#C586C0', type: '#DCDCAA', enum: '#569CD6', const: '#DCDCAA',
  import: '#7dd3fc', export: '#f9a8d4',
};

const TYPE_LABELS: Record<string, string> = {
  ts: 'TypeScript', js: 'JavaScript', md: 'Markdown', fn: 'Function',
  url: 'URL', db: 'Database', py: 'Python', rs: 'Rust', go: 'Go',
  cpp: 'C++', c: 'C', cs: 'C#', java: 'Java', class: 'Class',
  interface: 'Interface', type: 'Type', enum: 'Enum', const: 'Const',
  import: 'Import', export: 'Export',
};

const CODEFLOW_FRAME_TYPES = new Set([
  'ts', 'js', 'py', 'rs', 'go', 'cpp', 'c', 'cs', 'java', 'php', 'rb', 'swift', 'kt',
  'css', 'scss', 'sh', 'ps1'
]);

const CODEFLOW_EXCLUDED_FILE_NAMES = new Set([
  '.gitignore', '.prettierignore', '.prettierrc', '.vscodeignore', 'license', 'procfile'
]);

const CODEFLOW_EXCLUDED_EXTENSIONS = new Set([
  '.vsix', '.zip', '.html', '.htm', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.ico',
  '.webp', '.bmp', '.lock', '.log', '.map', '.min.js', '.min.css'
]);

// ─── Custom Node ──────────────────────────────────────────────────────────────

interface CustomNodeData {
  label: string;
  nodeType: string;
  filePath?: string;
  line?: number;
  snippet?: string;
  snippetStartLine?: number;
  controls?: Array<{
    name: string;
    controlType: 'color' | 'range' | 'toggle' | 'text';
    value: string | number | boolean;
    min?: number;
    max?: number;
    step?: number;
    quote?: string;
  }>;
  [key: string]: unknown;
}

function renderHighlightedSnippet(snippet: string): ReactNode[] {
  const tokenRe = /(\/\/.*$|\/\*[\s\S]*?\*\/|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b\d+(?:\.\d+)?\b|\b(?:export|import|from|return|const|let|var|function|class|interface|type|enum|extends|implements|async|await|if|else|for|while|switch|case|default|new|try|catch|throw|public|private|protected|static)\b)/gm;
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenRe.exec(snippet)) !== null) {
    if (match.index > lastIndex) {
      parts.push(snippet.slice(lastIndex, match.index));
    }

    const value = match[0];
    let color = 'var(--vscode-editor-foreground, #d4d4d4)';
    if (value.startsWith('//') || value.startsWith('/*')) {
      color = 'var(--vscode-descriptionForeground, #6a9955)';
    } else if (value.startsWith('"') || value.startsWith("'") || value.startsWith('`')) {
      color = 'var(--vscode-terminal-ansiGreen, #ce9178)';
    } else if (/^\d/.test(value)) {
      color = 'var(--vscode-terminal-ansiMagenta, #b5cea8)';
    } else {
      color = 'var(--vscode-symbolIconKeywordForeground, #569cd6)';
    }

    parts.push(
      <span key={`${match.index}:${value}`} style={{ color }}>
        {value}
      </span>
    );
    lastIndex = match.index + value.length;
  }

  if (lastIndex < snippet.length) {
    parts.push(snippet.slice(lastIndex));
  }

  return parts;
}

function CustomNode({ data }: { data: CustomNodeData }) {
  const color = TYPE_COLORS[data.nodeType] || '#888';
  const label = TYPE_LABELS[data.nodeType] || data.nodeType;
  const isFileNode = Boolean(data.isFileNode);
  const snippet = typeof data.snippet === 'string' ? data.snippet : '';
  const snippetStartLine = typeof data.snippetStartLine === 'number' ? data.snippetStartLine : undefined;
  const controls = Array.isArray(data.controls) ? data.controls : [];
  const [isSnippetExpanded, setIsSnippetExpanded] = useState(false);
  const [controlValues, setControlValues] = useState<Record<string, string | number | boolean>>(() =>
    Object.fromEntries(controls.map(control => [control.name, control.value]))
  );
  const preventNodeDrag = (event: React.SyntheticEvent) => {
    event.stopPropagation();
  };
  const sendControlUpdate = (
    control: NonNullable<CustomNodeData['controls']>[number],
    value: string | number | boolean
  ) => {
    if (!data.filePath) return;
    getVscode()?.postMessage({
      type: 'updateVariableControl',
      path: data.filePath,
      variableName: control.name,
      value,
      controlType: control.controlType,
      quote: control.quote,
    });
  };
  const snippetToggleLabel = isSnippetExpanded ? 'Hide code' : 'Show code';

  return (
    <>
      <Handle type="target" position={Position.Left} style={{ background: color, border: 'none', width: 8, height: 8 }} />
      <div style={{
      padding: isFileNode ? '10px 14px' : '10px 12px',
      border: `2px solid ${color}`,
      borderRadius: isFileNode ? '12px' : '8px',
      background: isFileNode ? 'rgba(78,201,176,0.10)' : 'var(--vscode-editor-background, #1e1e1e)',
      color: 'var(--vscode-editor-foreground, #fff)',
      fontSize: '11px',
      minWidth: isFileNode ? '220px' : '210px',
      maxWidth: '280px',
      boxSizing: 'border-box',
    }}>
      <div style={{ fontWeight: 600, marginBottom: '2px', color }}>{isFileNode ? 'File' : label}</div>
      <div style={{ fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {data.label}
      </div>
      {(data.filePath || data.line) && (
        <div style={{
          marginTop: '4px',
          fontSize: '9px',
          color: 'var(--vscode-descriptionForeground, #888)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          opacity: 0.8
        }}>
          {data.filePath?.split(/[/\\]/).pop()}
          {typeof data.line === 'number' ? `:${data.line}` : ''}
        </div>
      )}
      {snippet && (
        <div style={{ marginTop: '8px' }}>
          <button
            className="nodrag"
            type="button"
            onPointerDown={preventNodeDrag}
            onMouseDown={preventNodeDrag}
            onClick={(event) => {
              preventNodeDrag(event);
              setIsSnippetExpanded(prev => !prev);
            }}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              padding: '4px 8px',
              borderRadius: '999px',
              border: '1px solid rgba(255,255,255,0.12)',
              background: 'rgba(255,255,255,0.05)',
              color: 'var(--vscode-editor-foreground, #d4d4d4)',
              fontSize: '10px',
              cursor: 'pointer',
            }}
          >
            <span aria-hidden="true">{isSnippetExpanded ? '▾' : '▸'}</span>
            {snippetToggleLabel}
          </button>
        </div>
      )}
      {controls.length > 0 && (
        <div style={{ marginTop: '8px', display: 'grid', gap: '8px' }}>
          {controls.map((control) => (
            <label key={control.name} style={{ display: 'grid', gap: '4px', fontSize: '10px' }}>
              <span style={{ color: 'var(--vscode-descriptionForeground, #999)' }}>{control.name}</span>
              {control.controlType === 'color' && (
                <input
                  className="nodrag"
                  type="color"
                  value={typeof controlValues[control.name] === 'string' ? String(controlValues[control.name]) : '#ffffff'}
                  onPointerDown={preventNodeDrag}
                  onMouseDown={preventNodeDrag}
                  onClick={preventNodeDrag}
                  onChange={(event) => {
                    const value = event.target.value;
                    setControlValues(prev => ({ ...prev, [control.name]: value }));
                    sendControlUpdate(control, value);
                  }}
                  style={{ width: '100%', height: '28px', background: 'transparent', border: 'none', padding: 0 }}
                />
              )}
              {control.controlType === 'range' && (
                <div style={{ display: 'grid', gap: '4px' }}>
                  <input
                    className="nodrag"
                    type="range"
                    min={control.min}
                    max={control.max}
                    step={control.step ?? 1}
                    value={typeof controlValues[control.name] === 'number' ? Number(controlValues[control.name]) : Number(control.value)}
                    onPointerDown={preventNodeDrag}
                    onMouseDown={preventNodeDrag}
                    onClick={preventNodeDrag}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      setControlValues(prev => ({ ...prev, [control.name]: value }));
                      sendControlUpdate(control, value);
                    }}
                  />
                  <span style={{ color: 'var(--vscode-descriptionForeground, #999)' }}>{String(controlValues[control.name] ?? control.value)}</span>
                </div>
              )}
              {control.controlType === 'toggle' && (
                <input
                  className="nodrag"
                  type="checkbox"
                  checked={Boolean(controlValues[control.name])}
                  onPointerDown={preventNodeDrag}
                  onMouseDown={preventNodeDrag}
                  onClick={preventNodeDrag}
                  onChange={(event) => {
                    const value = event.target.checked;
                    setControlValues(prev => ({ ...prev, [control.name]: value }));
                    sendControlUpdate(control, value);
                  }}
                />
              )}
              {control.controlType === 'text' && (
                <input
                  className="nodrag"
                  type="text"
                  value={String(controlValues[control.name] ?? control.value)}
                  onPointerDown={preventNodeDrag}
                  onMouseDown={preventNodeDrag}
                  onClick={preventNodeDrag}
                  onChange={(event) => {
                    const value = event.target.value;
                    setControlValues(prev => ({ ...prev, [control.name]: value }));
                    sendControlUpdate(control, value);
                  }}
                  style={{
                    width: '100%',
                    padding: '6px 8px',
                    borderRadius: '6px',
                    border: '1px solid rgba(255,255,255,0.12)',
                    background: 'rgba(255,255,255,0.04)',
                    color: 'var(--vscode-editor-foreground, #fff)'
                  }}
                />
              )}
            </label>
          ))}
        </div>
      )}
      {snippet && isSnippetExpanded && (
        <pre style={{
          marginTop: '8px',
          padding: '8px 10px',
          borderRadius: '8px',
          background: 'rgba(0, 0, 0, 0.22)',
          border: '1px solid rgba(255,255,255,0.08)',
          color: 'var(--vscode-editor-foreground, #d4d4d4)',
          fontSize: '10px',
          lineHeight: 1.45,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          fontFamily: "Consolas, 'Courier New', monospace",
          maxHeight: '180px',
          overflow: 'auto',
        }}>
          {snippetStartLine ? `${snippetStartLine}| ` : ''}
          {renderHighlightedSnippet(snippet)}
        </pre>
      )}
    </div>
      <Handle type="source" position={Position.Right} style={{ background: color, border: 'none', width: 8, height: 8 }} />
    </>
  );
}

const nodeTypes = { custom: CustomNode, frame: FrameNode };

// ─── Frame Node component ─────────────────────────────────────────────────────

interface FrameNodeData {
  label: string;
  filePath: string;
  childCount: number;
  nodeType: string;
}

function FrameNode({ data }: { data: FrameNodeData }) {
  return (
    <div style={{
      width: '100%',
      height: '100%',
      padding: '12px 14px',
      border: '2px dashed #6b7280',
      borderRadius: '16px',
      background: 'linear-gradient(180deg, rgba(55,65,81,0.18), rgba(30,41,59,0.10))',
      color: '#9ca3af',
      fontSize: '10px',
      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)',
    }}>
      <Handle type="target" position={Position.Left} style={{ background: 'rgba(156,163,175,0.9)', border: 'none', width: 10, height: 10 }} />
      <Handle type="source" position={Position.Right} style={{ background: 'rgba(156,163,175,0.9)', border: 'none', width: 10, height: 10 }} />
      <NodeResizer
        minWidth={280}
        minHeight={180}
        lineStyle={{ borderColor: 'var(--vscode-focusBorder, #4ec9b0)' }}
        handleStyle={{
          width: 10,
          height: 10,
          borderRadius: 3,
          border: 'none',
          background: 'transparent',
          opacity: 0,
        }}
      />
      <div style={{ fontWeight: 700, marginBottom: '4px', fontSize: '12px', color: 'var(--vscode-editor-foreground, #ddd)' }}>{data.label}</div>
      <div style={{ fontSize: '9px', opacity: 0.7 }}>{data.childCount} nodes in file</div>
    </div>
  );
}

// ─── Layout helper ────────────────────────────────────────────────────────────

interface LayoutResult {
  nodePositions: Map<string, { x: number; y: number }>;
  framePositions: Map<string, { x: number; y: number; width: number; height: number }>;
}

function getParentFile(node: CodeNode): string | undefined {
  if (typeof node.parentId === 'string' && node.parentId) return node.parentId;
  const metaParent = node.meta?.parent;
  if (typeof metaParent === 'string' && metaParent) return metaParent;
  if (node.filePath && !node.id.startsWith('url:')) return node.filePath;
  return undefined;
}

function getFrameLabel(filePath: string): string {
  return filePath.split(/[/\\]/).pop() || filePath;
}

function isExcludedCodeFlowFilePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  const fileName = normalized.split('/').pop() || normalized;
  if (CODEFLOW_EXCLUDED_FILE_NAMES.has(fileName)) return true;
  return Array.from(CODEFLOW_EXCLUDED_EXTENSIONS).some(ext => fileName.endsWith(ext));
}

function isCodeFlowFrameFile(node: CodeNode, filePath: string): boolean {
  if (!filePath || isExcludedCodeFlowFilePath(filePath)) return false;
  return CODEFLOW_FRAME_TYPES.has(node.type);
}

function filterCodeFlowGraph(nodes: CodeNode[], edges: CodeEdge[]) {
  const fileNodes = new Map<string, CodeNode>();
  for (const node of nodes) {
    if (node.filePath && node.id === node.filePath) {
      fileNodes.set(node.filePath, node);
    }
  }

  const allowedFrameFiles = new Set<string>();
  for (const [filePath, node] of fileNodes) {
    if (isCodeFlowFrameFile(node, filePath)) {
      allowedFrameFiles.add(filePath);
    }
  }

  const filteredNodes = nodes.filter((node) => {
    const parentFile = getParentFile(node);
    if (!parentFile || !allowedFrameFiles.has(parentFile)) return false;
    if (node.type === 'url') return false;
    return true;
  });

  const filteredNodeIds = new Set(filteredNodes.map(node => node.id));
  const filteredEdges = edges.filter((edge) => filteredNodeIds.has(edge.source) && filteredNodeIds.has(edge.target));

  return { nodes: filteredNodes, edges: filteredEdges, allowedFrameFiles };
}

interface LayerGraph {
  adjacency: Map<string, Set<string>>;
  indegree: Map<string, number>;
  outdegree: Map<string, number>;
}

function createLayerGraph(ids: Iterable<string>): LayerGraph {
  const adjacency = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();
  const outdegree = new Map<string, number>();

  for (const id of ids) {
    adjacency.set(id, new Set());
    indegree.set(id, 0);
    outdegree.set(id, 0);
  }

  return { adjacency, indegree, outdegree };
}

function addLayerEdge(graph: LayerGraph, source: string, target: string) {
  if (source === target) return;
  const next = graph.adjacency.get(source);
  if (!next || next.has(target)) return;
  next.add(target);
  graph.outdegree.set(source, (graph.outdegree.get(source) ?? 0) + 1);
  graph.indegree.set(target, (graph.indegree.get(target) ?? 0) + 1);
}

function computeLayerMap(ids: Iterable<string>, graph: LayerGraph): Map<string, number> {
  const idList = Array.from(ids);
  const indegree = new Map(graph.indegree);
  const queue = idList
    .filter(id => (indegree.get(id) ?? 0) === 0)
    .sort((a, b) => a.localeCompare(b));
  const layers = new Map<string, number>();
  const visited = new Set<string>();

  while (queue.length > 0) {
    const id = queue.shift()!;
    visited.add(id);
    const currentLayer = layers.get(id) ?? 0;

    for (const neighbor of graph.adjacency.get(id) ?? []) {
      layers.set(neighbor, Math.max(layers.get(neighbor) ?? 0, currentLayer + 1));
      const nextIndegree = (indegree.get(neighbor) ?? 0) - 1;
      indegree.set(neighbor, nextIndegree);
      if (nextIndegree === 0) {
        queue.push(neighbor);
        queue.sort((a, b) => a.localeCompare(b));
      }
    }
  }

  for (const id of idList.sort((a, b) => a.localeCompare(b))) {
    if (visited.has(id)) continue;
    let inferredLayer = 0;
    for (const [source, targets] of graph.adjacency) {
      if (targets.has(id)) {
        inferredLayer = Math.max(inferredLayer, (layers.get(source) ?? 0) + 1);
      }
    }
    layers.set(id, inferredLayer);
  }

  return layers;
}

function compareByFlowPriority(
  a: string,
  b: string,
  indegree: Map<string, number>,
  outdegree: Map<string, number>,
  labels?: Map<string, string>
): number {
  const aIn = indegree.get(a) ?? 0;
  const bIn = indegree.get(b) ?? 0;
  const aOut = outdegree.get(a) ?? 0;
  const bOut = outdegree.get(b) ?? 0;
  const aBalance = aOut - aIn;
  const bBalance = bOut - bIn;

  if (aBalance !== bBalance) return bBalance - aBalance;
  if (aOut !== bOut) return bOut - aOut;
  if (aIn !== bIn) return aIn - bIn;

  const aLabel = labels?.get(a) ?? a;
  const bLabel = labels?.get(b) ?? b;
  return aLabel.localeCompare(bLabel);
}

function getLaneOrder(node: CodeNode, filePath: string): number {
  if (node.id === filePath) return 1;
  if (node.type === 'import') return 0;
  if (['class', 'interface', 'type', 'enum'].includes(node.type)) return 2;
  if (node.type === 'const') return 3;
  if (node.type === 'fn') return 4;
  if (node.type === 'export') return 5;
  return 4;
}

function estimateControlHeight(controlType: unknown): number {
  if (controlType === 'toggle') return 44;
  if (controlType === 'color') return 64;
  if (controlType === 'range') return 68;
  if (controlType === 'text') return 64;
  return 56;
}

function estimateNodeCardHeight(node: CodeNode): number {
  let height = 92;
  const controls = Array.isArray(node.meta?.controls)
    ? node.meta.controls as Array<Record<string, unknown>>
    : [];

  if (controls.length > 0) {
    height += 10;
    controls.forEach((control, index) => {
      height += estimateControlHeight(control.controlType);
      if (index < controls.length - 1) height += 8;
    });
  }

  if (typeof node.meta?.snippet === 'string' && node.meta.snippet.trim().length > 0) {
    height += 38;
  }

  return Math.max(118, height);
}

function layoutGraph(nodes: CodeNode[], edges: CodeEdge[]): LayoutResult {
  const nodePositions = new Map<string, { x: number; y: number }>();
  const framePositions = new Map<string, { x: number; y: number; width: number; height: number }>();

  const fileGroups = new Map<string, CodeNode[]>();
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  const nodeToFrame = new Map<string, string>();

  for (const node of nodes) {
    const parentFile = getParentFile(node);
    if (!parentFile) continue;
    if (!fileGroups.has(parentFile)) {
      fileGroups.set(parentFile, []);
    }
    fileGroups.get(parentFile)!.push(node);
    nodeToFrame.set(node.id, parentFile);
  }

  const framePaddingX = 32;
  const framePaddingY = 28;
  const frameHeaderHeight = 78;
  const innerGapY = 24;
  const cardWidth = 280;
  const frameSpacingX = 128;
  const frameSpacingY = 96;
  const startX = 72;
  const startY = 60;
  const frameIds = Array.from(fileGroups.keys());
  const frameGraph = createLayerGraph(frameIds);
  const frameLabels = new Map(frameIds.map(filePath => [filePath, getFrameLabel(filePath)]));

  for (const edge of edges) {
    const sourceFrame = nodeToFrame.get(edge.source);
    const targetFrame = nodeToFrame.get(edge.target);
    if (!sourceFrame || !targetFrame || sourceFrame === targetFrame) continue;
    addLayerEdge(frameGraph, sourceFrame, targetFrame);
  }

  const frameLayers = computeLayerMap(frameIds, frameGraph);
  const frameBoxes = new Map<string, { width: number; height: number }>();
  const framesByLayer = new Map<number, string[]>();

  for (const filePath of frameIds) {
    const group = fileGroups.get(filePath) ?? [];
    const memberNodes = group
      .filter(node => node.id !== filePath);
    const cards = [...memberNodes].sort((a, b) => {
      const lane = getLaneOrder(a, filePath) - getLaneOrder(b, filePath);
      if (lane !== 0) return lane;
      return a.label.localeCompare(b.label);
    });
    const cardHeights = cards.map(estimateNodeCardHeight);

    const frameWidth = Math.max(372, framePaddingX * 2 + cardWidth);
    const contentHeight = cardHeights.reduce((sum, height) => sum + height, 0);
    const frameHeight = Math.max(
      220,
      frameHeaderHeight + framePaddingY * 2 + contentHeight + Math.max(0, cards.length - 1) * innerGapY
    );

    let currentY = frameHeaderHeight + framePaddingY;
    cards.forEach((node, index) => {
      const x = framePaddingX;
      const y = currentY;
      nodePositions.set(node.id, { x, y });
      currentY += cardHeights[index] + innerGapY;
    });

    frameBoxes.set(filePath, { width: frameWidth, height: frameHeight });
    const frameLayer = frameLayers.get(filePath) ?? 0;
    if (!framesByLayer.has(frameLayer)) framesByLayer.set(frameLayer, []);
    framesByLayer.get(frameLayer)!.push(filePath);
  }

  const orderedFrameLayers = Array.from(framesByLayer.keys()).sort((a, b) => a - b);
  let frameX = startX;

  for (const layer of orderedFrameLayers) {
    const layerFrames = framesByLayer.get(layer) ?? [];
    layerFrames.sort((a, b) => compareByFlowPriority(a, b, frameGraph.indegree, frameGraph.outdegree, frameLabels));

    let frameY = startY;
    let maxWidthInLayer = 0;

    for (const filePath of layerFrames) {
      const frameBox = frameBoxes.get(filePath);
      if (!frameBox) continue;
      framePositions.set(filePath, {
        x: frameX,
        y: frameY,
        width: frameBox.width,
        height: frameBox.height,
      });
      frameY += frameBox.height + frameSpacingY;
      maxWidthInLayer = Math.max(maxWidthInLayer, frameBox.width);
    }

    frameX += maxWidthInLayer + frameSpacingX;
  }

  return { nodePositions, framePositions };
}

// ─── Log Panel ────────────────────────────────────────────────────────────────

const LogPanel: FC<{ logs: LogEntry[]; phase: string; progress: { scanned: number; total: number } }> =
  ({ logs, phase, progress }) => {
    const logRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
      if (logRef.current) {
        logRef.current.scrollTop = logRef.current.scrollHeight;
      }
    }, [logs.length]);

    const phaseLabel = phase === 'discovering' ? '🔍 Discovering files…'
      : phase === 'scanning' ? `📂 Scanning files… (${progress.scanned}/${progress.total})`
      : phase === 'linking' ? '🔗 Resolving cross-file references…'
      : phase === 'done' ? `✅ Done — ${progress.total} files scanned`
      : '⏳ Waiting…';

    const pct = progress.total > 0 ? Math.round((progress.scanned / progress.total) * 100) : 0;

    return (
      <div style={{
        position: 'absolute', bottom: 0, left: 0, right: 0,
        maxHeight: '180px',
        display: 'flex', flexDirection: 'column',
        background: 'var(--vscode-sideBar-background, rgba(30,30,30,0.95))',
        borderTop: '1px solid var(--vscode-panel-border, rgba(128,128,128,0.3))',
        zIndex: 30, fontSize: '11px', fontFamily: 'monospace',
        transition: 'max-height 0.3s ease',
      }}>
        {/* Progress bar */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: '8px',
          padding: '4px 8px',
          borderBottom: '1px solid var(--vscode-panel-border, rgba(128,128,128,0.2))',
        }}>
          <span style={{ color: 'var(--vscode-editor-foreground, #ccc)', flexShrink: 0 }}>{phaseLabel}</span>
          {phase !== 'done' && progress.total > 0 && (
            <div style={{
              flex: 1, height: '4px', borderRadius: '2px',
              background: 'rgba(128,128,128,0.2)', overflow: 'hidden',
            }}>
              <div style={{
                width: `${pct}%`, height: '100%', borderRadius: '2px',
                background: 'var(--vscode-textLink-foreground, #4ec9b0)',
                transition: 'width 0.15s ease',
              }} />
            </div>
          )}
        </div>
        {/* Log entries */}
        <div ref={logRef} style={{
          overflow: 'auto', flex: 1, padding: '2px 8px',
          color: 'var(--vscode-editor-foreground, #aaa)',
        }}>
          {logs.slice(-60).map((l, i) => (
            <div key={i} style={{
              lineHeight: '16px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              opacity: l.type === 'node' ? 0.6 : 0.85,
              color: l.type === 'phase' ? 'var(--vscode-textLink-foreground, #4ec9b0)'
                : l.type === 'node' ? '#DCDCAA'
                : 'inherit',
            }}>
              {l.text}
            </div>
          ))}
        </div>
      </div>
    );
  };

// ─── Flow Graph ───────────────────────────────────────────────────────────────

interface FlowGraphProps {
  rfNodes: unknown[];
  rfEdges: unknown[];
  visibleNodeIds?: Set<string> | null;
  onNodeOpen: (node: CodeNode) => void;
  onSelectionChange: (selectedIds: string[]) => void;
}

const FlowGraph: FC<FlowGraphProps> = ({ rfNodes, rfEdges, visibleNodeIds, onNodeOpen, onSelectionChange }) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [nodes, setNodes, onNodesChange] = useNodesState<any>([]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [edges, setEdges, onEdgesChange] = useEdgesState<any>([]);
  const { fitView, getNodes, screenToFlowPosition } = useReactFlow();
  const fitPendingRef = useRef(false);
  const hasAutoFitRef = useRef(false);
  const nodesRef = useRef(rfNodes);
  const edgesRef = useRef(rfEdges);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [boxSelect, setBoxSelect] = useState<{ startX: number; startY: number; currentX: number; currentY: number } | null>(null);

  // Keep the rendered graph in sync, but only auto-fit on first load.
  useEffect(() => {
    nodesRef.current = rfNodes;
    edgesRef.current = rfEdges;
    setNodes(rfNodes as never[]);
    setEdges(rfEdges as never[]);

    if (rfNodes.length > 0 && !fitPendingRef.current && !hasAutoFitRef.current) {
      fitPendingRef.current = true;
      const timer = setTimeout(() => {
        fitView({ padding: 0.2, duration: 0 });
        fitPendingRef.current = false;
        hasAutoFitRef.current = true;
      }, 800);
      return () => clearTimeout(timer);
    }
  }, [rfNodes, rfEdges]);

  useEffect(() => {
    setNodes((existing) => existing.map((node) => ({
      ...node,
      hidden: visibleNodeIds ? !visibleNodeIds.has(node.id) : false,
    })));
    setEdges((existing) => existing.map((edge) => ({
      ...edge,
      hidden: visibleNodeIds ? !visibleNodeIds.has(edge.source) || !visibleNodeIds.has(edge.target) : false,
    })));
  }, [visibleNodeIds, setEdges, setNodes]);

  const handleNodeDoubleClick = useCallback((_event: React.MouseEvent, node: { id: string; data: CustomNodeData }) => {
    const d = node.data;
    if (d.filePath) {
      onNodeOpen({ id: node.id, label: d.label, type: d.nodeType, filePath: d.filePath, meta: { line: d.line } });
    }
  }, [onNodeOpen]);

  useEffect(() => {
    if (!boxSelect) return;

    const handleMouseMove = (event: MouseEvent) => {
      setBoxSelect((current) => current ? { ...current, currentX: event.clientX, currentY: event.clientY } : null);
    };

    const handleMouseUp = () => {
      setBoxSelect((current) => {
        if (!current) return null;

        const start = screenToFlowPosition({ x: current.startX, y: current.startY });
        const end = screenToFlowPosition({ x: current.currentX, y: current.currentY });
        const minX = Math.min(start.x, end.x);
        const maxX = Math.max(start.x, end.x);
        const minY = Math.min(start.y, end.y);
        const maxY = Math.max(start.y, end.y);
        const moved = Math.hypot(current.currentX - current.startX, current.currentY - current.startY) > 5;

        if (moved) {
          const selectedIds = new Set(
            getNodes()
              .filter((node) => {
                const abs = (node as { positionAbsolute?: { x: number; y: number } }).positionAbsolute ?? node.position;
                const width = Number((node as { width?: number; measured?: { width?: number } }).width ?? (node as { measured?: { width?: number } }).measured?.width ?? 160);
                const height = Number((node as { height?: number; measured?: { height?: number } }).height ?? (node as { measured?: { height?: number } }).measured?.height ?? 70);
                const overlapsX = abs.x <= maxX && abs.x + width >= minX;
                const overlapsY = abs.y <= maxY && abs.y + height >= minY;
                return overlapsX && overlapsY;
              })
              .map((node) => node.id)
          );

          setNodes((existing) => existing.map((node) => ({ ...node, selected: selectedIds.has(node.id) })));
        }

        return null;
      });
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [boxSelect, getNodes, screenToFlowPosition, setNodes]);

  const handleWrapperMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 2) return;
    event.preventDefault();
    setBoxSelect({
      startX: event.clientX,
      startY: event.clientY,
      currentX: event.clientX,
      currentY: event.clientY,
    });
  }, []);

  return (
    <div
      ref={wrapperRef}
      style={{ width: '100%', height: '100%', position: 'relative' }}
      onMouseDown={handleWrapperMouseDown}
      onContextMenu={(event) => {
        if (boxSelect) event.preventDefault();
      }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDoubleClick={handleNodeDoubleClick}
        onSelectionChange={({ nodes: selectedNodes }) => {
          onSelectionChange(selectedNodes.map((node) => node.id));
        }}
        nodeTypes={nodeTypes}
        fitView={false}
        minZoom={0.2}
        maxZoom={2.2}
        nodesDraggable={true}
        elementsSelectable={true}
        selectNodesOnDrag={true}
        onlyRenderVisibleElements={false}
        panOnDrag={[1]}
        defaultEdgeOptions={{ type: 'step', style: { strokeWidth: 2 } }}
        attributionPosition="bottom-left"
        style={{ background: 'var(--vscode-editor-background, #1e1e1e)' }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
      </ReactFlow>
      {boxSelect && (
        <div
          style={{
            position: 'fixed',
            left: Math.min(boxSelect.startX, boxSelect.currentX),
            top: Math.min(boxSelect.startY, boxSelect.currentY),
            width: Math.abs(boxSelect.currentX - boxSelect.startX),
            height: Math.abs(boxSelect.currentY - boxSelect.startY),
            border: '1px solid rgba(255,255,255,0.55)',
            background: 'rgba(255,255,255,0.10)',
            pointerEvents: 'none',
            zIndex: 20,
          }}
        />
      )}
    </div>
  );
};

// ─── VS Code API ──────────────────────────────────────────────────────────────

interface VsCodeApi {
  postMessage: (msg: Record<string, unknown>) => void;
}

interface InitialCodeGraphState {
  showFns?: boolean;
  filterText?: string;
}

function buildSearchVisibleIds(
  rfNodes: Array<{ id: string; parentId?: string; data?: CustomNodeData }>,
  searchText: string
): Set<string> | null {
  const query = searchText.trim().toLowerCase();
  if (!query) return null;

  const visibleIds = new Set<string>();
  const childrenByFrame = new Map<string, string[]>();

  for (const node of rfNodes) {
    if (!node.parentId) continue;
    if (!childrenByFrame.has(node.parentId)) childrenByFrame.set(node.parentId, []);
    childrenByFrame.get(node.parentId)!.push(node.id);
  }

  for (const node of rfNodes) {
    const haystack = [
      node.data?.label,
      node.data?.filePath,
      node.data?.nodeType,
    ]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .join(' ')
      .toLowerCase();

    if (!haystack.includes(query)) continue;

    visibleIds.add(node.id);
    if (node.parentId) visibleIds.add(node.parentId);

    if (node.id.startsWith('frame:')) {
      for (const childId of childrenByFrame.get(node.id) ?? []) {
        visibleIds.add(childId);
      }
    }
  }

  return visibleIds;
}

function intersectVisibleIds(...sets: Array<Set<string> | null>): Set<string> | null {
  const activeSets = sets.filter((set): set is Set<string> => Boolean(set));
  if (activeSets.length === 0) return null;
  const [first, ...rest] = activeSets;
  return new Set(Array.from(first).filter((id) => rest.every((set) => set.has(id))));
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeApi;
    __vscodeApi?: VsCodeApi;
    __ultraviewCodeGraphState?: InitialCodeGraphState;
  }
}

function getVscode(): VsCodeApi | undefined {
  return window.__vscodeApi || window.acquireVsCodeApi?.();
}

// ─── Main App ─────────────────────────────────────────────────────────────────

function App() {
  const initialShowFns = window.__ultraviewCodeGraphState?.showFns ?? false;
  const [rfNodes, setRfNodes] = useState<unknown[]>([]);
  const [rfEdges, setRfEdges] = useState<unknown[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [phase, setPhase] = useState<string>('waiting');
  const [progress, setProgress] = useState({ scanned: 0, total: 0 });
  const [isolatedSeedIds, setIsolatedSeedIds] = useState<string[]>([]);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [searchText, setSearchText] = useState(window.__ultraviewCodeGraphState?.filterText ?? '');

  // Accumulators — we use refs so the message handler always sees the latest
  const nodeAccRef = useRef<unknown[]>([]);
  const edgeAccRef = useRef<unknown[]>([]);
  const nodeCountRef = useRef(0);
  const edgeSetRef = useRef(new Set<string>());

  useEffect(() => {
    const searchInput = document.getElementById('search') as HTMLInputElement | null;
    if (!searchInput) return;

    searchInput.value = searchText;
    const handleInput = (event: Event) => {
      const nextValue = (event.target as HTMLInputElement).value;
      setSearchText(nextValue);
      getVscode()?.postMessage({ type: 'saveProjectState', state: { filterText: nextValue } });
    };

    searchInput.addEventListener('input', handleInput);
    return () => searchInput.removeEventListener('input', handleInput);
  }, [searchText]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const msg = event.data as Record<string, unknown>;

      // Legacy bulk message (from normal code graph)
      if (msg.type === 'graphData') {
        const allNodes = msg.nodes as CodeNode[];
        const allEdges = msg.edges as CodeEdge[];
        const newRfNodes: unknown[] = [];
        const newRfEdges: unknown[] = [];
        const edgeSet = new Set<string>();
        const filteredGraph = filterCodeFlowGraph(allNodes, allEdges);
        const filteredNodes = filteredGraph.nodes;
        const filteredEdges = filteredGraph.edges;

        const nodeById = new Map(filteredNodes.map(node => [node.id, node]));
        const frameGroups = new Map<string, CodeNode[]>();
        for (const node of filteredNodes) {
          const parentFile = getParentFile(node);
          if (!parentFile) continue;
          if (!frameGroups.has(parentFile)) frameGroups.set(parentFile, []);
          frameGroups.get(parentFile)!.push(node);
        }

        const layout = layoutGraph(filteredNodes, filteredEdges);

        // Add frame nodes
        for (const [filePath, framePos] of layout.framePositions) {
          if (!filteredGraph.allowedFrameFiles.has(filePath)) continue;
          const childCount = frameGroups.get(filePath)?.length ?? 0;
          newRfNodes.push({
            id: `frame:${filePath}`,
            type: 'frame',
            position: { x: framePos.x, y: framePos.y },
            style: {
              width: framePos.width,
              height: framePos.height,
              background: 'transparent',
              border: 'none',
              overflow: 'visible',
            },
            data: { label: getFrameLabel(filePath), filePath, childCount, nodeType: 'frame' },
          });
        }

        // Add grouped file-scoped nodes inside their frame.
        for (const node of filteredNodes) {
          const parentFile = getParentFile(node);
          if (!parentFile) continue;
          if (node.id === parentFile) continue;
          const pos = layout.nodePositions.get(node.id);
          if (!pos) continue;
          const line = typeof node.meta?.line === 'number' ? node.meta.line : undefined;
          newRfNodes.push({
            id: node.id,
            type: 'custom',
            position: pos,
            data: {
              label: node.label,
              nodeType: node.type,
              filePath: node.filePath,
              line,
              snippet: typeof node.meta?.snippet === 'string' ? node.meta.snippet : undefined,
              snippetStartLine: typeof node.meta?.snippetStartLine === 'number' ? node.meta.snippetStartLine : undefined,
              controls: Array.isArray(node.meta?.controls) ? node.meta.controls : undefined,
            },
            parentId: `frame:${parentFile}`,
            extent: 'parent' as const,
          });
        }

        // Keep edges attached to the real nodes so cross-file usage stays visible.
        for (const e of filteredEdges) {
          const key = `${e.source}-${e.target}-${e.kind}`;
          if (edgeSet.has(key)) continue;
          edgeSet.add(key);
          const sourceNode = nodeById.get(e.source);
          const targetNode = nodeById.get(e.target);
          if (!sourceNode || !targetNode) continue;
          if (sourceNode.id === getParentFile(sourceNode) || targetNode.id === getParentFile(targetNode)) continue;
          const isImport = e.kind === 'import';
          const isCall = e.kind === 'call';
          const isUse = e.kind === 'use';
          const isExport = e.kind === 'export';
          newRfEdges.push({
            id: key,
            source: e.source,
            target: e.target,
            type: isCall ? 'bezier' : 'smoothstep',
            animated: isCall,
            style: {
              stroke: isImport ? '#4EC9B0' : isCall ? '#DCDCAA' : isUse ? '#7dd3fc' : isExport ? '#f9a8d4' : '#C586C0',
              strokeWidth: isCall ? 2.4 : isUse ? 1.8 : 2,
              strokeDasharray: isUse ? '6 4' : undefined,
            },
          });
        }

        const frameEdgeSet = new Set<string>();
        for (const e of filteredEdges) {
          const sourceFrame = getParentFile(nodeById.get(e.source)!);
          const targetFrame = getParentFile(nodeById.get(e.target)!);
          if (!sourceFrame || !targetFrame || sourceFrame === targetFrame) continue;
          const frameKey = `frame:${sourceFrame}->frame:${targetFrame}`;
          if (frameEdgeSet.has(frameKey)) continue;
          frameEdgeSet.add(frameKey);
          newRfEdges.push({
            id: frameKey,
            source: `frame:${sourceFrame}`,
            target: `frame:${targetFrame}`,
            type: 'smoothstep',
            animated: false,
            style: {
              stroke: 'rgba(156,163,175,0.35)',
              strokeWidth: 1.4,
            },
            zIndex: 0,
          });
        }

        nodeAccRef.current = newRfNodes;
        edgeAccRef.current = newRfEdges;
        setRfNodes(newRfNodes);
        setRfEdges(newRfEdges);
        setPhase('done');
        setProgress({ scanned: filteredNodes.length, total: filteredNodes.length });
        return;
      }

      // Streaming batch message - for now, skip frames in streaming mode
      if (msg.type === 'graphBatch') {
        const batchPhase = msg.phase as string;
        const batchNodes = msg.nodes as CodeNode[] || [];
        const batchEdges = msg.edges as CodeEdge[] || [];
        const file = msg.file as string | undefined;

        setPhase(batchPhase);

        if (msg.totalFiles !== undefined) {
          setProgress({ scanned: msg.scannedFiles as number || 0, total: msg.totalFiles as number });
        }

        // Add log entries
        const newLogs: LogEntry[] = [];
        if (batchPhase === 'discovering') {
          newLogs.push({ text: '🔍 Discovering workspace files…', type: 'phase' });
        } else if (batchPhase === 'linking') {
          newLogs.push({ text: '🔗 Resolving cross-file call references…', type: 'phase' });
        } else if (batchPhase === 'done') {
          newLogs.push({ text: `✅ Scan complete — ${msg.totalFiles} files processed`, type: 'phase' });
        }

        if (file && batchPhase === 'scanning') {
          newLogs.push({ text: `  📄 ${file}`, type: 'file' });
        }

        for (const n of batchNodes) {
          const typeLabel = TYPE_LABELS[n.type] || n.type;
          newLogs.push({ text: `     + ${typeLabel}: ${n.label}`, type: 'node' });
        }

        if (newLogs.length > 0) {
          setLogs(prev => [...prev.slice(-200), ...newLogs]);
        }

        // Add new nodes
        if (batchNodes.length > 0) {
          const newRfNodes: unknown[] = [];
          for (const n of batchNodes) {
            const idx = nodeCountRef.current++;
            newRfNodes.push({
              id: n.id, type: 'custom',
              position: { x: (idx % 6) * 280, y: Math.floor(idx / 6) * 120 },
              data: { label: n.label, nodeType: n.type, filePath: n.filePath },
            });
          }
          nodeAccRef.current = [...nodeAccRef.current, ...newRfNodes];
          setRfNodes([...nodeAccRef.current]);
        }

        // Add new edges
        if (batchEdges.length > 0) {
          const newRfEdges: unknown[] = [];
          for (const e of batchEdges) {
            const key = `${e.source}-${e.target}-${e.kind}`;
            if (edgeSetRef.current.has(key)) continue;
            edgeSetRef.current.add(key);
            const isImport = e.kind === 'import';
            const isCall = e.kind === 'call';
            newRfEdges.push({
              id: key, source: e.source, target: e.target, type: 'step',
              animated: isCall,
              style: { stroke: isImport ? '#4EC9B0' : isCall ? '#DCDCAA' : '#C586C0', strokeWidth: 2 },
            });
          }
          if (newRfEdges.length > 0) {
            edgeAccRef.current = [...edgeAccRef.current, ...newRfEdges];
            setRfEdges([...edgeAccRef.current]);
          }
        }
      }
    };

    window.addEventListener('message', handleMessage);

    // Request graph data (non-streaming for frame layout)
    const vscode = getVscode();
    vscode?.postMessage({ type: 'ready', streaming: false, showFns: initialShowFns });

    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const handleNodeOpen = useCallback((node: CodeNode) => {
    const vscode = getVscode();
    vscode?.postMessage({ type: 'openFile', path: node.filePath || node.id, line: node.meta?.line });
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'i') return;
      const target = event.target as HTMLElement | null;
      if (target && (
        target.tagName === 'INPUT'
        || target.tagName === 'TEXTAREA'
        || target.isContentEditable
      )) {
        return;
      }
      event.preventDefault();
      setIsolatedSeedIds((current) => {
        if (current.length > 0) return [];
        if (selectedNodeIds.length === 0) return current;
        return [...selectedNodeIds];
      });
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedNodeIds]);

  const isolatedVisibleIds = useMemo(() => {
    if (isolatedSeedIds.length === 0) return null;

    const allNodes = rfNodes as Array<{ id: string; parentId?: string }>;
    const allEdges = rfEdges as Array<{ source: string; target: string }>;
    const childrenByFrame = new Map<string, string[]>();
    const includedIds = new Set<string>();
    const adjacency = new Map<string, Set<string>>();

    for (const node of allNodes) {
      if (!node.parentId) continue;
      if (!childrenByFrame.has(node.parentId)) childrenByFrame.set(node.parentId, []);
      childrenByFrame.get(node.parentId)!.push(node.id);
    }

    for (const edge of allEdges) {
      if (!adjacency.has(edge.source)) adjacency.set(edge.source, new Set());
      if (!adjacency.has(edge.target)) adjacency.set(edge.target, new Set());
      adjacency.get(edge.source)!.add(edge.target);
      adjacency.get(edge.target)!.add(edge.source);
    }

    for (const isolatedNodeId of isolatedSeedIds) {
      includedIds.add(isolatedNodeId);
      const seedIds = isolatedNodeId.startsWith('frame:')
        ? (childrenByFrame.get(isolatedNodeId) ?? [])
        : [isolatedNodeId];
      const queue = seedIds.filter((id) => !includedIds.has(id));
      seedIds.forEach((id) => includedIds.add(id));

      while (queue.length > 0) {
        const currentId = queue.shift()!;
        for (const neighbor of adjacency.get(currentId) ?? []) {
          if (includedIds.has(neighbor)) continue;
          includedIds.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    for (const node of allNodes) {
      if (includedIds.has(node.id) && node.parentId) {
        includedIds.add(node.parentId);
      }
    }
    return includedIds;
  }, [isolatedSeedIds, rfEdges, rfNodes]);

  const searchVisibleIds = useMemo(
    () => buildSearchVisibleIds(rfNodes as Array<{ id: string; parentId?: string; data?: CustomNodeData }>, searchText),
    [rfNodes, searchText]
  );

  const visibleNodeIds = useMemo(
    () => intersectVisibleIds(isolatedVisibleIds, searchVisibleIds),
    [isolatedVisibleIds, searchVisibleIds]
  );

  const summaryText = useMemo(() => {
    const counts = new Map<string, number>();

    for (const rawNode of rfNodes as Array<{ id: string; data?: CustomNodeData }>) {
      if (visibleNodeIds && !visibleNodeIds.has(rawNode.id)) continue;
      if (rawNode.id.startsWith('frame:')) continue;
      const nodeType = rawNode.data?.nodeType;
      if (!nodeType) continue;
      counts.set(nodeType, (counts.get(nodeType) ?? 0) + 1);
    }

    const orderedTypes: Array<[string, string]> = [
      ['ts', 'files'],
      ['js', 'js'],
      ['fn', 'functions'],
      ['const', 'variables'],
      ['interface', 'interfaces'],
      ['type', 'types'],
      ['class', 'classes'],
      ['enum', 'enums'],
      ['import', 'imports'],
      ['export', 'exports'],
    ];

    return orderedTypes
      .map(([type, label]) => {
        const count = counts.get(type) ?? 0;
        return count > 0 ? `${count} ${label}` : null;
      })
      .filter((value): value is string => Boolean(value))
      .join('  |  ');
  }, [visibleNodeIds, rfNodes]);

  return (
    <div style={{ width: '100%', height: '100vh', background: 'var(--vscode-editor-background, #1e1e1e)', position: 'relative' }}>
      <ReactFlowProvider>
        <FlowGraph
          rfNodes={rfNodes}
          rfEdges={rfEdges}
          visibleNodeIds={visibleNodeIds}
          onNodeOpen={handleNodeOpen}
          onSelectionChange={setSelectedNodeIds}
        />
        <Panel position="top-right" style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground, #888)' }}>
          {summaryText}
        </Panel>
      </ReactFlowProvider>
      <LogPanel logs={logs} phase={phase} progress={progress} />
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        .react-flow__node { cursor: pointer; }
        .react-flow__edge:hover { stroke-width: 3; }
      `}</style>
    </div>
  );
}

// ─── Mount ────────────────────────────────────────────────────────────────────

const loadingEl = document.getElementById('loading');
if (loadingEl) loadingEl.style.display = 'none';

const root = createRoot(document.getElementById('app')!);
root.render(React.createElement(App));

