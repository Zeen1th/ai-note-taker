// Shared types — mirror the Rust structs in src-tauri/src/db.rs

export interface Board {
  id: string;
  name: string;
  sourceSessionId?: string | null;
  createdAt: string;
  updatedAt: string;
  nodeCount: number;
}

export type NodeKind = 'note' | 'reference' | 'node' | 'group';

export interface BoardNode {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  c: number;      // color index 0-5
  kind: NodeKind; // 'note' = text (+ inline image) | 'reference' = whole image | 'node' = container | 'group' = layout box
  image: string;  // image id for notes with an image / references
  customTitle?: string;
  blocks?: string | null;  // TipTap JSON document (block tree), serialized
  tags?: string[];
  parentId?: string | null; // container id for cards inside a 'node' kind card
}

export interface TagInfo {
  name: string;
  color: number;  // 0 = unassigned (frontend default), 1-5 = --spN
  count: number;
}

export interface BoardEdge {
  id: string;
  fromId: string;
  toId: string;
  color: number;
  label: string;
}

export interface TrashEntry {
  id: number;
  boardId: string;
  cardId: string;
  data: string;  // JSON of the deleted BoardNode
  deletedAt: string;
}

export interface BoardResponse {
  board: Partial<Board>;
  nodes: BoardNode[];
  edges: BoardEdge[];
}

export type Tool = 'select' | 'note' | 'reference' | 'node' | 'group' | 'connect';

export interface ViewState {
  x: number;
  y: number;
  zoom: number;
}
