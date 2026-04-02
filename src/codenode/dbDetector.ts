import * as path from 'path';
import type { CodeNode, CodeEdge } from './types';

const DB_EXTS = ['.db', '.sqlite', '.sqlite3', '.db3', '.duckdb', '.ddb', '.mdb', '.accdb'];

export function detectDb(filePath: string): { nodes: CodeNode[]; edges: CodeEdge[] } {
  const nodes: CodeNode[] = [];
  const edges: CodeEdge[] = [];
  const ext = path.extname(filePath).toLowerCase();
  if (!DB_EXTS.includes(ext)) return { nodes, edges };

  nodes.push({ id: filePath, label: path.basename(filePath), type: 'db', filePath });
  // No edges for DB files (unless you want to parse SQL, which is out of scope for now)
  return { nodes, edges };
}
