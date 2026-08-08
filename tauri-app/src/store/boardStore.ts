import { create } from 'zustand';
import type { BoardNode, BoardEdge } from '../lib/types';
import { getBoard, putBoard } from '../lib/tauri';

export interface ViewState { x: number; y: number; zoom: number; }

interface BoardStore {
  // data
  nodes: BoardNode[];
  edges: BoardEdge[];
  view: ViewState;
  selectedIds: Set<string>;
  currentBoardId: string;
  loaded: boolean;

  // actions
  loadBoard: (boardId: string) => Promise<void>;
  addNode: (x: number, y: number, text?: string) => BoardNode;
  updateNode: (id: string, patch: Partial<BoardNode>) => void;
  deleteNode: (id: string) => void;
  duplicateNode: (id: string) => void;
  addEdge: (from: string, to: string) => void;
  deleteEdge: (id: string) => void;
  setView: (v: Partial<ViewState>) => void;
  selectNode: (id: string, additive?: boolean) => void;
  selectNodes: (ids: string[]) => void;
  clearSelection: () => void;

  // persistence (debounced)
  _saveTimer: ReturnType<typeof setTimeout> | null;
  scheduleSave: () => void;
}

const SAVE_DELAY = 350;
const DEFAULT_W = 270;
const DEFAULT_H = 175;

function newId() {
  return 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export const useBoardStore = create<BoardStore>((set, get) => ({
  nodes: [],
  edges: [],
  view: { x: 0, y: 0, zoom: 1 },
  selectedIds: new Set(),
  currentBoardId: '',
  loaded: false,
  _saveTimer: null,

  loadBoard: async (boardId: string) => {
    const data = await getBoard(boardId);
    // migrate old nodes
    const nodes = data.nodes.map((n) => ({
      ...n,
      w: n.w || DEFAULT_W,
      h: n.h || DEFAULT_H,
      image: n.image || '',
      kind: n.kind || 'note',
    }));
    const edges = data.edges.map((e) => ({
      ...e,
      color: e.color || 0,
      label: e.label || '',
    }));
    // restore view from localStorage
    let view = { x: 0, y: 0, zoom: 1 };
    try {
      const raw = localStorage.getItem('nt-view-' + boardId);
      if (raw) view = JSON.parse(raw);
    } catch {}
    set({ nodes, edges, view, currentBoardId: boardId, loaded: true, selectedIds: new Set() });
  },

  addNode: (x, y, text = '') => {
    const node: BoardNode = {
      id: newId(),
      x: x - DEFAULT_W / 2,
      y: y - 30,
      w: DEFAULT_W,
      h: DEFAULT_H,
      text,
      c: Math.floor(Math.random() * 5),
      kind: 'note',
      image: '',
    };
    set((s) => ({ nodes: [...s.nodes, node], selectedIds: new Set([node.id]) }));
    get().scheduleSave();
    return node;
  },

  updateNode: (id, patch) => {
    set((s) => ({
      nodes: s.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
    }));
    get().scheduleSave();
  },

  deleteNode: (id) => {
    set((s) => ({
      nodes: s.nodes.filter((n) => n.id !== id),
      edges: s.edges.filter((e) => e.fromId !== id && e.toId !== id),
      selectedIds: new Set([...s.selectedIds].filter((x) => x !== id)),
    }));
    get().scheduleSave();
  },

  duplicateNode: (id) => {
    const s = get();
    const n = s.nodes.find((x) => x.id === id);
    if (!n) return;
    const copy: BoardNode = { ...n, id: newId(), x: n.x + 30, y: n.y + 30 };
    set((st) => ({ nodes: [...st.nodes, copy], selectedIds: new Set([copy.id]) }));
    get().scheduleSave();
  },

  addEdge: (from, to) => {
    const edge: BoardEdge = {
      id: 'e' + Date.now().toString(36),
      fromId: from,
      toId: to,
      color: 0,
      label: '',
    };
    set((s) => ({ edges: [...s.edges, edge] }));
    get().scheduleSave();
    return edge;
  },

  deleteEdge: (id) => {
    set((s) => ({ edges: s.edges.filter((e) => e.id !== id) }));
    get().scheduleSave();
  },

  setView: (v) => {
    set((s) => {
      const view = { ...s.view, ...v };
      // persist view to localStorage immediately
      try { localStorage.setItem('nt-view-' + s.currentBoardId, JSON.stringify(view)); } catch {}
      return { view };
    });
  },

  selectNode: (id, additive = false) => {
    set((s) => {
      if (additive) {
        const next = new Set(s.selectedIds);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return { selectedIds: next };
      }
      return { selectedIds: new Set([id]) };
    });
  },

  selectNodes: (ids) => set({ selectedIds: new Set(ids) }),

  clearSelection: () => set({ selectedIds: new Set() }),

  scheduleSave: () => {
    const state = get();
    if (state._saveTimer) clearTimeout(state._saveTimer);
    const timer = setTimeout(() => {
      const s = get();
      if (!s.currentBoardId) return;
      // convert edges to the format Rust expects (from/to keys)
      const edgesPayload = s.edges.map((e) => ({
        id: e.id, from: e.fromId, to: e.toId, color: e.color, label: e.label,
      }));
      putBoard(s.currentBoardId, s.nodes, edgesPayload).catch(console.error);
    }, SAVE_DELAY);
    set({ _saveTimer: timer });
  },
}));
