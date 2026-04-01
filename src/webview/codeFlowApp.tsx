import React, { useCallback, useEffect, useState, useMemo, useRef, type FC } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  BackgroundVariant,
  Panel,
  useReactFlow,
  ReactFlowProvider,
  Handle,
  Position,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

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
};

const TYPE_LABELS: Record<string, string> = {
  ts: 'TypeScript', js: 'JavaScript', md: 'Markdown', fn: 'Function',
  url: 'URL', db: 'Database', py: 'Python', rs: 'Rust', go: 'Go',
  cpp: 'C++', c: 'C', cs: 'C#', java: 'Java', class: 'Class',
  interface: 'Interface', type: 'Type', enum: 'Enum', const: 'Const',
};

// ─── Custom Node ──────────────────────────────────────────────────────────────

interface CustomNodeData {
  label: string;
  nodeType: string;
  filePath?: string;
  [key: string]: unknown;
}

function CustomNode({ data }: { data: CustomNodeData }) {
  const color = TYPE_COLORS[data.nodeType] || '#888';
  const label = TYPE_LABELS[data.nodeType] || data.nodeType;
  const isFileNode = Boolean(data.isFileNode);
  return (
    <>
      <Handle type="target" position={Position.Left} style={{ background: color, border: 'none', width: 8, height: 8 }} />
      <div style={{
      padding: isFileNode ? '10px 14px' : '8px 12px',
      border: `2px solid ${color}`,
      borderRadius: isFileNode ? '12px' : '8px',
      background: isFileNode ? 'rgba(78,201,176,0.10)' : 'var(--vscode-editor-background, #1e1e1e)',
      color: 'var(--vscode-editor-foreground, #fff)',
      fontSize: '11px',
      minWidth: isFileNode ? '140px' : '100px',
      maxWidth: '200px',
    }}>
      <div style={{ fontWeight: 600, marginBottom: '2px', color }}>{isFileNode ? 'File' : label}</div>
      <div style={{ fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {data.label}
      </div>
      {data.nodeType === 'fn' && data.filePath && (
        <div style={{
          marginTop: '4px',
          fontSize: '9px',
          color: 'var(--vscode-descriptionForeground, #888)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          opacity: 0.8
        }}>
          {data.filePath.split(/[/\\]/).pop()}
        </div>
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

function layoutGraph(nodes: CodeNode[], edges: CodeEdge[]): LayoutResult {
  const nodePositions = new Map<string, { x: number; y: number }>();
  const framePositions = new Map<string, { x: number; y: number; width: number; height: number }>();

  const frameOrder: string[] = [];
  const fileGroups = new Map<string, CodeNode[]>();

  for (const node of nodes) {
    const parentFile = getParentFile(node);
    if (!parentFile) continue;
    if (!fileGroups.has(parentFile)) {
      fileGroups.set(parentFile, []);
      frameOrder.push(parentFile);
    }
    fileGroups.get(parentFile)!.push(node);
  }

  const framePaddingX = 28;
  const framePaddingY = 24;
  const frameHeaderHeight = 70;
  const innerGapX = 28;
  const innerGapY = 18;
  const cardWidth = 172;
  const cardHeight = 72;
  const frameSpacingX = 96;
  const frameSpacingY = 96;
  const startX = 60;
  const startY = 60;
  const maxRowWidth = 3200;

  let frameX = startX;
  let frameY = startY;
  let currentRowHeight = 0;

  for (const filePath of frameOrder) {
    const group = fileGroups.get(filePath) ?? [];
    const fileNode = group.find(node => node.id === filePath);
    const memberNodes = group
      .filter(node => node.id !== filePath)
      .sort((a, b) => a.label.localeCompare(b.label));

    const totalCards = 1 + memberNodes.length;
    const columnCount = Math.max(1, Math.min(3, Math.ceil(Math.sqrt(totalCards))));
    const rowCount = Math.max(1, Math.ceil(totalCards / columnCount));
    const frameWidth = Math.max(320, framePaddingX * 2 + columnCount * cardWidth + (columnCount - 1) * innerGapX);
    const frameHeight = Math.max(
      180,
      frameHeaderHeight + framePaddingY * 2 + rowCount * cardHeight + (rowCount - 1) * innerGapY
    );

    if (frameX > startX && frameX + frameWidth > maxRowWidth) {
      frameX = startX;
      frameY += currentRowHeight + frameSpacingY;
      currentRowHeight = 0;
    }

    framePositions.set(filePath, {
      x: frameX,
      y: frameY,
      width: frameWidth,
      height: frameHeight,
    });

    const cards = fileNode ? [fileNode, ...memberNodes] : memberNodes;
    cards.forEach((node, idx) => {
      const col = idx % columnCount;
      const row = Math.floor(idx / columnCount);
      const x = framePaddingX + col * (cardWidth + innerGapX);
      const y = frameHeaderHeight + framePaddingY + row * (cardHeight + innerGapY);
      nodePositions.set(node.id, { x, y });
    });

    frameX += frameWidth + frameSpacingX;
    currentRowHeight = Math.max(currentRowHeight, frameHeight);
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
  onNodeClick: (node: CodeNode) => void;
}

const FlowGraph: FC<FlowGraphProps> = ({ rfNodes, rfEdges, onNodeClick }) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [nodes, setNodes, onNodesChange] = useNodesState<any>([]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [edges, setEdges, onEdgesChange] = useEdgesState<any>([]);
  const { fitView } = useReactFlow();
  const fitPendingRef = useRef(false);
  const nodesRef = useRef(rfNodes);
  const edgesRef = useRef(rfEdges);

  // Only update when the actual data changes (not on every render)
  useEffect(() => {
    nodesRef.current = rfNodes;
    edgesRef.current = rfEdges;
    if (rfNodes.length > 0 && !fitPendingRef.current) {
      fitPendingRef.current = true;
      // Delay fitView to allow initial layout to settle
      const timer = setTimeout(() => {
        setNodes(rfNodes as never[]);
        setEdges(rfEdges as never[]);
        fitView({ padding: 0.2, duration: 0 });
        fitPendingRef.current = false;
      }, 800);
      return () => clearTimeout(timer);
    }
  }, [rfNodes, rfEdges]);

  // Initial node/edge set
  useEffect(() => {
    if (rfNodes.length > 0) {
      setNodes(rfNodes as never[]);
      setEdges(rfEdges as never[]);
    }
  }, []);

  const handleNodeClick = useCallback((_event: React.MouseEvent, node: { id: string; data: CustomNodeData }) => {
    const d = node.data;
    if (d.filePath) {
      onNodeClick({ id: node.id, label: d.label, type: d.nodeType, filePath: d.filePath, meta: { line: d.line } });
    }
  }, [onNodeClick]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={handleNodeClick}
      nodeTypes={nodeTypes}
      fitView={false}
      minZoom={0.1}
      maxZoom={2}
      nodesDraggable={true}
      selectNodesOnDrag={false}
      panOnDrag={true}
      defaultEdgeOptions={{ type: 'step', style: { strokeWidth: 2 } }}
      attributionPosition="bottom-left"
      style={{ background: 'var(--vscode-editor-background, #1e1e1e)' }}
    >
      <Controls />
      <MiniMap
        nodeColor={(n) => TYPE_COLORS[(n.data as CustomNodeData)?.nodeType] || '#888'}
        style={{ background: 'var(--vscode-sideBar-background, #252526)' }}
        maskColor="rgba(0,0,0,0.1)"
      />
      <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
    </ReactFlow>
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
  const initialShowFns = window.__ultraviewCodeGraphState?.showFns ?? true;
  const initialFilterText = window.__ultraviewCodeGraphState?.filterText ?? '';
  const [rfNodes, setRfNodes] = useState<unknown[]>([]);
  const [rfEdges, setRfEdges] = useState<unknown[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [phase, setPhase] = useState<string>('waiting');
  const [progress, setProgress] = useState({ scanned: 0, total: 0 });
  const [searchTerm, setSearchTerm] = useState(initialFilterText);

  // Accumulators — we use refs so the message handler always sees the latest
  const nodeAccRef = useRef<unknown[]>([]);
  const edgeAccRef = useRef<unknown[]>([]);
  const nodeCountRef = useRef(0);
  const edgeSetRef = useRef(new Set<string>());

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

        const nodeById = new Map(allNodes.map(node => [node.id, node]));
        const frameGroups = new Map<string, CodeNode[]>();
        for (const node of allNodes) {
          const parentFile = getParentFile(node);
          if (!parentFile) continue;
          if (!frameGroups.has(parentFile)) frameGroups.set(parentFile, []);
          frameGroups.get(parentFile)!.push(node);
        }

        const layout = layoutGraph(allNodes, allEdges);

        // Add frame nodes
        for (const [filePath, framePos] of layout.framePositions) {
          const childCount = frameGroups.get(filePath)?.length ?? 0;
          newRfNodes.push({
            id: `frame:${filePath}`,
            type: 'frame',
            position: { x: framePos.x, y: framePos.y },
            draggable: false,
            selectable: false,
            style: {
              width: framePos.width,
              height: framePos.height,
              background: 'transparent',
              border: 'none',
            },
            data: { label: getFrameLabel(filePath), filePath, childCount, nodeType: 'frame' },
          });
        }

        // Add all file-scoped nodes inside their frame, including the file node itself.
        for (const node of allNodes) {
          const parentFile = getParentFile(node);
          if (!parentFile) continue;
          const pos = layout.nodePositions.get(node.id);
          if (!pos) continue;
          const isFileNode = node.id === parentFile;
          const line = typeof node.meta?.line === 'number' ? node.meta.line : undefined;
          newRfNodes.push({
            id: node.id,
            type: 'custom',
            position: pos,
            data: { label: node.label, nodeType: node.type, filePath: node.filePath, line, isFileNode },
            parentId: `frame:${parentFile}`,
            extent: 'parent' as const,
          });
        }

        // Keep edges attached to the real nodes so cross-file usage stays visible.
        for (const e of allEdges) {
          const key = `${e.source}-${e.target}-${e.kind}`;
          if (edgeSet.has(key)) continue;
          edgeSet.add(key);
          const isImport = e.kind === 'import';
          const isCall = e.kind === 'call';
          if (!nodeById.has(e.source) || !nodeById.has(e.target)) continue;
          newRfEdges.push({
            id: key,
            source: e.source,
            target: e.target,
            type: isCall ? 'bezier' : 'smoothstep',
            animated: isCall,
            style: { stroke: isImport ? '#4EC9B0' : isCall ? '#DCDCAA' : '#C586C0', strokeWidth: isCall ? 2.4 : 2 },
          });
        }

        nodeAccRef.current = newRfNodes;
        edgeAccRef.current = newRfEdges;
        setRfNodes(newRfNodes);
        setRfEdges(newRfEdges);
        setPhase('done');
        setProgress({ scanned: allNodes.length, total: allNodes.length });
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

  useEffect(() => {
    const vscode = getVscode();
    vscode?.postMessage({ type: 'saveProjectState', state: { filterText: searchTerm } });
  }, [searchTerm]);

  const handleNodeClick = useCallback((node: CodeNode) => {
    const vscode = getVscode();
    vscode?.postMessage({ type: 'openFile', path: node.filePath || node.id, line: node.meta?.line });
  }, []);

  // Filter if search term is active
  const filteredNodes = useMemo(() => {
    if (!searchTerm) return rfNodes;
    const term = searchTerm.toLowerCase();
    return rfNodes.filter((n: unknown) => {
      const data = (n as { data: CustomNodeData }).data;
      return data.label.toLowerCase().includes(term) || (data.filePath?.toLowerCase().includes(term));
    });
  }, [rfNodes, searchTerm]);

  const filteredEdges = useMemo(() => {
    if (!searchTerm) return rfEdges;
    const nodeIds = new Set(filteredNodes.map((n: unknown) => (n as { id: string }).id));
    return rfEdges.filter((e: unknown) => {
      const edge = e as { source: string; target: string };
      return nodeIds.has(edge.source) && nodeIds.has(edge.target);
    });
  }, [rfEdges, searchTerm, filteredNodes]);

  return (
    <div style={{ width: '100%', height: '100vh', background: 'var(--vscode-editor-background, #1e1e1e)', position: 'relative' }}>
      <ReactFlowProvider>
        <FlowGraph rfNodes={filteredNodes} rfEdges={filteredEdges} onNodeClick={handleNodeClick} />
        <Panel position="top-left" style={{ width: '250px' }}>
          <input
            type="text"
            placeholder="Filter nodes…"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{
              width: '100%', padding: '6px 10px',
              background: 'var(--vscode-input-background, #3c3c3c)',
              color: 'var(--vscode-input-foreground, #fff)',
              border: '1px solid var(--vscode-input-border, rgba(128,128,128,0.4))',
              borderRadius: '4px', fontSize: '12px',
            }}
          />
        </Panel>
        <Panel position="top-right" style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground, #888)' }}>
          {filteredNodes.length} nodes | {filteredEdges.length} edges
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
