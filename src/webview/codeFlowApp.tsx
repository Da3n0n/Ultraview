import React, { useCallback, useEffect, useState, useMemo, type FC } from 'react';
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

interface GraphData {
  nodes: CodeNode[];
  edges: CodeEdge[];
}

const TYPE_COLORS: Record<string, string> = {
  ts: '#4EC9B0',
  js: '#F0DB4F',
  md: '#C586C0',
  fn: '#DCDCAA',
  url: '#569CD6',
  db: '#CE9178',
  py: '#3572A5',
  rs: '#DEA584',
  go: '#00ADD8',
  cpp: '#F34B7D',
  c: '#A97BFF',
  cs: '#178600',
  java: '#B07219',
  class: '#4EC9B0',
  interface: '#C586C0',
  type: '#DCDCAA',
  enum: '#569CD6',
  const: '#DCDCAA',
};

const TYPE_LABELS: Record<string, string> = {
  ts: 'TypeScript',
  js: 'JavaScript',
  md: 'Markdown',
  fn: 'Function',
  url: 'URL',
  db: 'Database',
  py: 'Python',
  rs: 'Rust',
  go: 'Go',
  cpp: 'C++',
  c: 'C',
  cs: 'C#',
  java: 'Java',
  class: 'Class',
  interface: 'Interface',
  type: 'Type',
  enum: 'Enum',
  const: 'Const',
};

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
    </div>
  );
}

interface FlowGraphProps {
  graphData: GraphData;
  onNodeClick: (node: CodeNode) => void;
}

const FlowGraph: FC<FlowGraphProps> = ({ graphData, onNodeClick }) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [nodes, setNodes, onNodesChange] = useNodesState<any>([]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [edges, setEdges, onEdgesChange] = useEdgesState<any>([]);
  const { fitView } = useReactFlow();

  useEffect(() => {
    if (!graphData || !graphData.nodes) return;

    const newNodes: unknown[] = [];
    const newEdges: unknown[] = [];
    const edgeSet = new Set<string>();

    for (const n of graphData.nodes) {
      const isFileType = !TYPE_COLORS[n.type] || n.type === 'ts' || n.type === 'js' || n.type === 'md';
      
      const nodeData: CustomNodeData = {
        label: n.label,
        nodeType: n.type,
        filePath: n.filePath,
      };

      newNodes.push({
        id: n.id,
        type: 'custom',
        position: { x: Math.random() * 800, y: Math.random() * 600 },
        data: nodeData,
      });
    }

    for (const e of graphData.edges) {
      const key = `${e.source}-${e.target}`;
      if (edgeSet.has(key)) continue;
      edgeSet.add(key);

      const isImport = e.kind === 'import';
      const isCall = e.kind === 'call';
      
      newEdges.push({
        id: `${e.source}-${e.target}`,
        source: e.source,
        target: e.target,
        type: 'smoothstep',
        animated: isCall,
        style: { 
          stroke: isImport ? '#4EC9B0' : isCall ? '#DCDCAA' : '#C586C0',
          strokeWidth: 2,
        },
        label: e.kind,
        labelStyle: { fill: '#888', fontSize: 10 },
        labelBgStyle: { fill: 'rgba(30,30,30,0.9)' },
      });
    }

    setNodes(newNodes as never[]);
    setEdges(newEdges as never[]);

    setTimeout(() => fitView({ padding: 0.2 }), 100);
  }, [graphData, setNodes, setEdges, fitView]);

  const handleNodeClick = useCallback((event: React.MouseEvent, node: { id: string; data: CustomNodeData }) => {
    const nodeData = node.data;
    if (nodeData.filePath) {
      onNodeClick({
        id: node.id,
        label: nodeData.label,
        type: nodeData.nodeType,
        filePath: nodeData.filePath,
      });
    }
  }, [onNodeClick]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={handleNodeClick}
      nodeTypes={{ custom: CustomNode }}
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

interface VsCodeApi {
  postMessage: (msg: Record<string, unknown>) => void;
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeApi;
  }
}

function App() {
  const [graphData, setGraphData] = useState<GraphData>({ nodes: [], edges: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const msg = event.data as Record<string, unknown>;
      if (msg.type === 'graphData') {
        setGraphData({ 
          nodes: msg.nodes as CodeNode[], 
          edges: msg.edges as CodeEdge[] 
        });
        setLoading(false);
      } else if (msg.type === 'error') {
        setError(msg.message as string);
        setLoading(false);
      }
    };

    window.addEventListener('message', handleMessage);
    
    const vscode = window.acquireVsCodeApi?.();
    vscode?.postMessage({ type: 'ready' });

    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const handleNodeClick = useCallback((node: CodeNode) => {
    const vscode = window.acquireVsCodeApi?.();
    vscode?.postMessage({ type: 'openFile', path: node.filePath || node.id });
  }, []);

  const filteredData = useMemo(() => {
    if (!searchTerm) return graphData;
    const term = searchTerm.toLowerCase();
    return {
      nodes: graphData.nodes.filter(n => 
        n.label.toLowerCase().includes(term) || 
        (n.filePath?.toLowerCase().includes(term))
      ),
      edges: graphData.edges.filter(e => {
        const sourceNode = graphData.nodes.find(n => n.id === e.source);
        const targetNode = graphData.nodes.find(n => n.id === e.target);
        return (
          sourceNode?.label.toLowerCase().includes(term) ||
          targetNode?.label.toLowerCase().includes(term) ||
          sourceNode?.filePath?.toLowerCase().includes(term) ||
          targetNode?.filePath?.toLowerCase().includes(term)
        );
      }),
    };
  }, [graphData, searchTerm]);

  if (loading) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        background: 'var(--vscode-editor-background, #1e1e1e)',
        color: 'var(--vscode-editor-foreground, #fff)',
      }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{
            width: 28,
            height: 28,
            borderRadius: '50%',
            border: '3px solid rgba(128,128,128,0.3)',
            borderTopColor: '#4ec9b0',
            animation: 'spin 0.7s linear infinite',
            margin: '0 auto 12px',
          }} />
          <span>Scanning workspace…</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        background: 'var(--vscode-editor-background, #1e1e1e)',
        color: '#f48772',
      }}>
        Error: {error}
      </div>
    );
  }

  return (
    <div style={{ width: '100%', height: '100vh', background: 'var(--vscode-editor-background, #1e1e1e)' }}>
      <ReactFlowProvider>
        <FlowGraph graphData={filteredData} onNodeClick={handleNodeClick} />
        <Panel position="top-left" style={{ width: '250px' }}>
          <input
            type="text"
            placeholder="Filter nodes…"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{
              width: '100%',
              padding: '6px 10px',
              background: 'var(--vscode-input-background, #3c3c3c)',
              color: 'var(--vscode-input-foreground, #fff)',
              border: '1px solid var(--vscode-input-border, rgba(128,128,128,0.4))',
              borderRadius: '4px',
              fontSize: '12px',
            }}
          />
        </Panel>
        <Panel position="top-right" style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground, #888)' }}>
          {filteredData.nodes.length} nodes | {filteredData.edges.length} edges
        </Panel>
      </ReactFlowProvider>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        .react-flow__node { cursor: pointer; }
        .react-flow__edge:hover { stroke-width: 3; }
      `}</style>
    </div>
  );
}

export default App;