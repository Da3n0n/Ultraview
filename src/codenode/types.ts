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

export interface StreamProgress {
  phase: 'discovering' | 'scanning' | 'linking' | 'done';
  file?: string;
  nodes: CodeNode[];
  edges: CodeEdge[];
  totalFiles?: number;
  scannedFiles?: number;
}
