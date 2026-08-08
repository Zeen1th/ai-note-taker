// Shared types — mirror the Rust structs in src-tauri/src/db.rs

export interface Board {
  id: string;
  name: string;
  sourceSessionId?: string | null;
  createdAt: string;
  updatedAt: string;
  nodeCount: number;
}

export interface BoardNode {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  c: number;      // color index 0-5
  kind: string;   // 'note' | 'image'
  image: string;  // URL for image nodes
  customTitle?: string;
  blocks?: string | null;  // TipTap JSON document (block tree), serialized
}

export interface BoardEdge {
  id: string;
  fromId: string;
  toId: string;
  color: number;
  label: string;
}

export interface BoardResponse {
  board: Partial<Board>;
  nodes: BoardNode[];
  edges: BoardEdge[];
}

export type Tool = 'select' | 'note' | 'image' | 'connect';
