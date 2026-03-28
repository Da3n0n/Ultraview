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
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

// ─── Types ────────────────────────────────────────────────────────────────────

interface CodeNode {
  id: string;
  label: string;
  type: string;
  filePath?: string;
  meta?: Record<string, unknown>;
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
  return (
    <div style={{
      padding: '8px 12px',
      border: `2px solid ${color}`,
      borderRadius: '8px',
      background: 'var(--vscode-editor-background, #1e1e1e)',
      color: 'var(--vscode-editor-foreground, #fff)',
      fontSize: '11px',
      minWidth: '100px',
      maxWidth: '200px',
    }}>
      <div style={{ fontWeight: 600, marginBottom: '2px', color }}>{label}</div>
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
  );
}

const nodeTypes = { custom: CustomNode };

// ─── Layout helper ────────────────────────────────────────────────────────────
// Distributes nodes in a grid pattern as they arrive
function assignPosition(index: number): { x: number; y: number } {
  const cols = 6;
  const spacingX = 250;
  const spacingY = 120;
  const col = index % cols;
  const row = Math.floor(index / cols);
  return { x: col * spacingX + (Math.random() - 0.5) * 40, y: row * spacingY + (Math.random() - 0.5) * 20 };
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

  useEffect(() => {
    setNodes(rfNodes as never[]);
    setEdges(rfEdges as never[]);
    // Fit view after a batch of nodes arrive (debounced)
    if (!fitPendingRef.current && rfNodes.length > 0) {
      fitPendingRef.current = true;
      setTimeout(() => {
        fitView({ padding: 0.2, duration: 300 });
        fitPendingRef.current = false;
      }, 500);
    }
  }, [rfNodes, rfEdges, setNodes, setEdges, fitView]);

  const handleNodeClick = useCallback((_event: React.MouseEvent, node: { id: string; data: CustomNodeData }) => {
    const d = node.data;
    if (d.filePath) {
      onNodeClick({ id: node.id, label: d.label, type: d.nodeType, filePath: d.filePath });
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
      fitView
      attributionPosition="bottom-left"
      style={{ background: 'var(--vscode-editor-background, #1e1e1e)' }}
    >
      <Controls />
      <MiniMap
        nodeColor={(n) => TYPE_COLORS[(n.data as CustomNodeData)?.nodeType] || '#888'}
        style={{ background: 'var(--vscode-sideBar-background, #252526)' }}
      />
      <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
    </ReactFlow>
  );
};

// ─── VS Code API ──────────────────────────────────────────────────────────────

interface VsCodeApi {
  postMessage: (msg: Record<string, unknown>) => void;
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeApi;
    __vscodeApi?: VsCodeApi;
  }
}

function getVscode(): VsCodeApi | undefined {
  return window.__vscodeApi || window.acquireVsCodeApi?.();
}

// ─── Main App ─────────────────────────────────────────────────────────────────

function App() {
  const [rfNodes, setRfNodes] = useState<unknown[]>([]);
  const [rfEdges, setRfEdges] = useState<unknown[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [phase, setPhase] = useState<string>('waiting');
  const [progress, setProgress] = useState({ scanned: 0, total: 0 });
  const [searchTerm, setSearchTerm] = useState('');

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
        const nodes = msg.nodes as CodeNode[];
        const edges = msg.edges as CodeEdge[];
        const newRfNodes: unknown[] = [];
        const newRfEdges: unknown[] = [];
        const edgeSet = new Set<string>();

        for (let i = 0; i < nodes.length; i++) {
          const n = nodes[i];
          newRfNodes.push({
            id: n.id, type: 'custom',
            position: assignPosition(i),
            data: { label: n.label, nodeType: n.type, filePath: n.filePath },
          });
        }
        for (const e of edges) {
          const key = `${e.source}-${e.target}-${e.kind}`;
          if (edgeSet.has(key)) continue;
          edgeSet.add(key);
          const isImport = e.kind === 'import';
          const isCall = e.kind === 'call';
          newRfEdges.push({
            id: key, source: e.source, target: e.target, type: 'smoothstep',
            animated: isCall,
            style: { stroke: isImport ? '#4EC9B0' : isCall ? '#DCDCAA' : '#C586C0', strokeWidth: 2 },
          });
        }
        nodeAccRef.current = newRfNodes;
        edgeAccRef.current = newRfEdges;
        setRfNodes(newRfNodes);
        setRfEdges(newRfEdges);
        setPhase('done');
        setProgress({ scanned: nodes.length, total: nodes.length });
        return;
      }

      // Streaming batch message
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
              position: assignPosition(idx),
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
              id: key, source: e.source, target: e.target, type: 'smoothstep',
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

    // Request streaming graph data
    const vscode = getVscode();
    vscode?.postMessage({ type: 'ready', streaming: true });

    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const handleNodeClick = useCallback((node: CodeNode) => {
    const vscode = getVscode();
    vscode?.postMessage({ type: 'openFile', path: node.filePath || node.id });
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
      return nodeIds.has(edge.source) || nodeIds.has(edge.target);
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