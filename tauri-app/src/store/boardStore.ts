import { create } from 'zustand';
import type { BoardNode, BoardEdge, TrashEntry, ViewState, NodeKind } from '../lib/types';
import { getBoard, putBoard, listTrash, saveToTrash, restoreTrash, deleteTrashEntry, syncTrash } from '../lib/tauri';

interface Snapshot { nodes: BoardNode[]; edges: BoardEdge[]; }

interface History {
  past: Snapshot[];
  future: Snapshot[];
}

interface BoardStore {
  // data
  nodes: BoardNode[];
  edges: BoardEdge[];
  view: ViewState;
  selectedIds: Set<string>;
  tagFilter: string | null;
  currentBoardId: string;
  loaded: boolean;
  trash: TrashEntry[];

  // per-board undo/redo
  history: Record<string, History>;

  // actions
  loadBoard: (boardId: string) => Promise<void>;
  addNode: (x: number, y: number, text?: string, kind?: NodeKind, parentId?: string | null) => BoardNode;
  updateNode: (id: string, patch: Partial<BoardNode>) => void;
  deleteNode: (id: string) => void;
  duplicateNode: (id: string) => void;
  addEdge: (from: string, to: string) => void;
  deleteEdge: (id: string) => void;
  setView: (v: Partial<ViewState>) => void;
  selectNode: (id: string, additive?: boolean) => void;
  selectNodes: (ids: string[]) => void;
  clearSelection: () => void;
  setTagFilter: (tag: string | null) => void;
  addNodeTag: (id: string, tag: string) => void;
  removeNodeTag: (id: string, tag: string) => void;
  undo: () => void;
  redo: () => void;

  // trash
  loadTrash: () => Promise<void>;
  restoreFromTrash: (id: number) => Promise<void>;
  discardTrashEntry: (id: number) => Promise<void>;

  // persistence (debounced)
  _saveTimer: ReturnType<typeof setTimeout> | null;
  scheduleSave: () => void;
}

const SAVE_DELAY = 350;
const DEFAULT_W = 400;
const DEFAULT_H = 280;
const MAX_HISTORY = 100;

function newId() {
  return 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Snapshot the pre-change state into the board's history stack.
function pushHistory(history: Record<string, History>, key: string, nodes: BoardNode[], edges: BoardEdge[]): Record<string, History> {
  const cur = history[key] || { past: [], future: [] };
  const entry: Snapshot = {
    nodes: nodes.map((n) => ({ ...n })),
    edges: edges.map((e) => ({ ...e })),
  };
  return { ...history, [key]: { past: [...cur.past.slice(-(MAX_HISTORY - 1)), entry], future: [] } };
}

export const useBoardStore = create<BoardStore>((set, get) => ({
  nodes: [],
  edges: [],
  view: { x: 0, y: 0, zoom: 1 },
  selectedIds: new Set(),
  tagFilter: null,
  currentBoardId: '',
  loaded: false,
  trash: [],
  history: {},
  _saveTimer: null,

  loadBoard: async (boardId: string) => {
    const data = await getBoard(boardId);
    // migrate old nodes
    const nodes = data.nodes.map((n) => ({
      ...n,
      w: n.w || DEFAULT_W,
      h: n.h || DEFAULT_H,
      image: n.image || '',
      kind: ((n.kind as string) === 'image' ? 'reference' : n.kind) as BoardNode['kind'],
      tags: n.tags || [],
      parentId: n.parentId ?? null,
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
    set({ nodes, edges, view, tagFilter: null, currentBoardId: boardId, loaded: true, selectedIds: new Set() });
  },

  addNode: (x, y, text = '', kind: BoardNode['kind'] = 'note', parentId: string | null = null) => {
    const isContainer = kind === 'node';
    const isGroup = kind === 'group';
    const node: BoardNode = {
      id: newId(),
      x: x - (isContainer ? 220 : isGroup ? 300 : DEFAULT_W) / 2,
      y: y - 30,
      w: isContainer ? 440 : isGroup ? 600 : DEFAULT_W,
      h: isContainer ? 320 : isGroup ? 400 : DEFAULT_H,
      text,
      c: Math.floor(Math.random() * 5),
      kind,
      image: '',
      tags: [],
      parentId,
    };
    set((s) => ({
      nodes: [...s.nodes, node],
      selectedIds: new Set([node.id]),
      history: pushHistory(s.history, s.currentBoardId, s.nodes, s.edges),
    }));
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
    const s = get();
    // deleting a container also deletes the cards inside it
    const doomed = [id, ...s.nodes.filter((n) => n.parentId === id).map((n) => n.id)];
    const victims = s.nodes.filter((n) => doomed.includes(n.id));
    set((st) => ({
      nodes: st.nodes.filter((n) => !doomed.includes(n.id)),
      edges: st.edges.filter((e) => !doomed.includes(e.fromId) && !doomed.includes(e.toId)),
      selectedIds: new Set([...st.selectedIds].filter((x) => !doomed.includes(x))),
      history: pushHistory(st.history, st.currentBoardId, st.nodes, st.edges),
    }));
    if (s.currentBoardId) {
      victims.forEach((node) => {
        saveToTrash(s.currentBoardId, node).catch(() => {});
      });
      if (victims.length) get().loadTrash().catch(() => {});
    }
    get().scheduleSave();
  },

  duplicateNode: (id) => {
    const s = get();
    const n = s.nodes.find((x) => x.id === id);
    if (!n) return;
    const copy: BoardNode = { ...n, id: newId(), x: n.x + 30, y: n.y + 30 };
    set((st) => ({
      nodes: [...st.nodes, copy],
      selectedIds: new Set([copy.id]),
      history: pushHistory(st.history, st.currentBoardId, st.nodes, st.edges),
    }));
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
    set((s) => ({
      edges: [...s.edges, edge],
      history: pushHistory(s.history, s.currentBoardId, s.nodes, s.edges),
    }));
    get().scheduleSave();
    return edge;
  },

  deleteEdge: (id) => {
    set((s) => ({
      edges: s.edges.filter((e) => e.id !== id),
      history: pushHistory(s.history, s.currentBoardId, s.nodes, s.edges),
    }));
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

  setTagFilter: (tag) => set({ tagFilter: tag }),

  addNodeTag: (id, tag) => {
    const tagName = tag.trim().replace(/^#/, '').replace(/\s+/g, '-').toLowerCase();
    if (!tagName) return;
    const node = get().nodes.find((n) => n.id === id);
    if (!node) return;
    const tags = node.tags || [];
    if (tags.includes(tagName)) return;
    set((s) => ({
      nodes: s.nodes.map((n) => (n.id === id ? { ...n, tags: [...tags, tagName] } : n)),
      history: pushHistory(s.history, s.currentBoardId, s.nodes, s.edges),
    }));
    get().scheduleSave();
  },

  removeNodeTag: (id, tag) => {
    set((s) => ({
      nodes: s.nodes.map((n) => (n.id === id ? { ...n, tags: (n.tags || []).filter((t) => t !== tag) } : n)),
      history: pushHistory(s.history, s.currentBoardId, s.nodes, s.edges),
    }));
    get().scheduleSave();
  },

  undo: () => {
    const s = get();
    const key = s.currentBoardId;
    const hist = s.history[key];
    if (!hist || hist.past.length === 0) return;
    const prev = hist.past[hist.past.length - 1];
    set((st) => ({
      nodes: prev.nodes,
      edges: prev.edges,
      selectedIds: new Set([...st.selectedIds].filter((id) => prev.nodes.some((n) => n.id === id))),
      history: {
        ...st.history,
        [key]: {
          past: hist.past.slice(0, -1),
          future: [
            { nodes: st.nodes.map((n) => ({ ...n })), edges: st.edges.map((e) => ({ ...e })) },
            ...hist.future,
          ].slice(0, MAX_HISTORY),
        },
      },
    }));
    get().scheduleSave();
    syncTrash().then(() => get().loadTrash()).catch(() => {});
  },

  redo: () => {
    const s = get();
    const key = s.currentBoardId;
    const hist = s.history[key];
    if (!hist || hist.future.length === 0) return;
    const next = hist.future[0];
    set((st) => ({
      nodes: next.nodes,
      edges: next.edges,
      selectedIds: new Set([...st.selectedIds].filter((id) => next.nodes.some((n) => n.id === id))),
      history: {
        ...st.history,
        [key]: {
          past: [...hist.past, { nodes: st.nodes.map((n) => ({ ...n })), edges: st.edges.map((e) => ({ ...e })) }],
          future: hist.future.slice(1),
        },
      },
    }));
    get().scheduleSave();
  },

  loadTrash: async () => {
    try {
      set({ trash: await listTrash() });
    } catch {
      set({ trash: [] });
    }
  },

  restoreFromTrash: async (id) => {
    const entry = get().trash.find((t) => t.id === id);
    await restoreTrash(id);
    await get().loadTrash();
    if (entry) await get().loadBoard(entry.boardId);
  },

  discardTrashEntry: async (id) => {
    await deleteTrashEntry(id);
    await get().loadTrash();
  },

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
