import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import './styles/theme.css';
import './styles/app.css';
import { listBoards, createBoard, deleteBoard, renameBoard, minimizeWindow, toggleMaximize, closeWindow, saveBoardImage, saveBoardImageFromPath, getSidecarUrl, saveMarkdownExport } from './lib/tauri';
import { convertFileSrc } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useUpdater, UpdateModal } from './components/UpdateModal';
import { useBoardStore } from './store/boardStore';
import { BoardNode } from './components/BoardNode';
import { BoardEdge } from './components/BoardEdge';
import { NoteModal } from './components/NoteModal';
import { ContextMenu, type CtxItem } from './components/ContextMenu';
import { Capture } from './components/Capture';
import { Settings } from './components/Settings';
import { Library } from './components/Library';
import { BoardTable } from './components/BoardTable';
import { DialogHost, showPrompt, showConfirm, showCustom } from './lib/dialogs';
import { Toasts, toast } from './lib/toast';
import { renderMarkdown } from './lib/markdown';
import { htmlToText } from './lib/editor/markdown';
import { buildBoardMarkdown } from './lib/exportBoard';
import { getAiCfg } from './lib/ai';
import { setInternalLinkHandler } from './lib/editor/extensions';
import type { LinkTargetItem } from './components/editor/format';
import { useTagStore, tagChipStyle } from './store/tagStore';
import type { Board, Tool, TrashEntry, BoardNode as BoardNodeData } from './lib/types';

interface ChatMsg { role: 'user' | 'assistant'; content: string }
const BOARD_CHIPS = [
  { label: 'Summarize', prompt: 'Summarize this board.' },
  { label: 'Action items', prompt: 'List the action items on this board.' },
  { label: 'Find gaps', prompt: 'What important points are missing from this board?' },
];

const PALETTES = ['notebook', 'blueprint', 'aurora'] as const;

const PASTE_IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'jfif', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tif', 'tiff', 'avif'];
const PASTE_MIME_EXTS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jfif': 'jfif',
  'image/pjpeg': 'jfif',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/tiff': 'tiff',
  'image/avif': 'avif',
};

// resolve a sensible extension for clipboard image data
function imageExtFor(name: string, type: string): string {
  const fromName = (name.split('.').pop() || '').toLowerCase();
  if (PASTE_IMAGE_EXTS.includes(fromName)) return '.' + fromName;
  const fromMime = PASTE_MIME_EXTS[(type || '').split(';')[0]];
  return fromMime ? '.' + fromMime : '.png';
}

function App() {
  const [boards, setBoards] = useState<Board[]>([]);
  const [palette, setPalette] = useState<string>(() => localStorage.getItem('nt-palette') || 'notebook');
  const [theme, setTheme] = useState<string>(() => localStorage.getItem('nt-theme') || 'light');

  const {
    nodes, edges, view, currentBoardId, selectedIds, tagFilter, trash, history,
    loadBoard, addNode, updateNode, deleteNode, deleteEdge, addEdge, duplicateNode, setView, selectNode, clearSelection, scheduleSave, setTagFilter,
    undo, redo, loadTrash, restoreFromTrash, discardTrashEntry,
  } = useBoardStore();

  const viewportRef = useRef<HTMLDivElement>(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const [modalNodeId, setModalNodeId] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; items: CtxItem[] } | null>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [provisional, setProvisional] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [selRect, setSelRect] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [screen, setScreen] = useState<'board' | 'library' | 'capture' | 'settings'>('board');
  // board ⇄ table (database) view, remembered per board
  const [viewMode, setViewMode] = useState<'board' | 'table'>('board');
  const imageInputRef = useRef<HTMLInputElement>(null);
  const imageDropPtRef = useRef<{ x: number; y: number } | null>(null);
  const imageDropNodeRef = useRef<string | null>(null);
  // parent container captured at picker/drop time (workspace node id or null for the board root)
  const imageDropParentRef = useRef<string | null>(null);
  // last mouse position over the board — where pasted images land
  const lastMouseRef = useRef<{ x: number; y: number } | null>(null);
  // on Windows the drop event can fire twice for a single drop — dedupe it
  const lastDropRef = useRef<{ t: number; key: string }>({ t: 0, key: '' });
  const [dragOverFile, setDragOverFile] = useState(false);

  // board AI chat sidebar
  const [chatOpen, setChatOpen] = useState(false);
  const [chats, setChats] = useState<Record<string, ChatMsg[]>>({});
  const [busyChat, setBusyChat] = useState(false);
  const [chatDraft, setChatDraft] = useState('');
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const [preview, setPreview] = useState<{ src: string } | null>(null);

  // workspace: a container ('node' kind) opened as a Notion-style list
  const [workspaceNodeId, setWorkspaceNodeId] = useState<string | null>(null);
  const [wsTitleDraft, setWsTitleDraft] = useState('');
  const [wsAddDraft, setWsAddDraft] = useState('');

  // auto-update: silent check at startup; titlebar button checks on press and
  // opens the changelog dialog (GitHub releases)
  const updater = useUpdater(toast);

  const workspaceNode = workspaceNodeId ? nodes.find((n) => n.id === workspaceNodeId) ?? null : null;
  const inWs = !!workspaceNode;
  // on the board only root cards are shown; inside a workspace only its children
  const displayed = useMemo(
    () => {
      const root = nodes.filter((n) => (n.parentId ?? null) === (workspaceNodeId ?? null));
      // groups are layout boxes — always rendered behind the cards
      return [...root.filter((n) => n.kind === 'group'), ...root.filter((n) => n.kind !== 'group')];
    },
    [nodes, workspaceNodeId],
  );
  const childrenOf = useCallback((id: string) => nodes.filter((n) => n.parentId === id), [nodes]);

  // drag a board card onto a container card to add it as a child
  const dragHoverIdRef = useRef<string | null>(null);
  const [dragHoverId, setDragHoverId] = useState<string | null>(null);

  // a picked/dropped image src (boardimg:// or raw id)
  const boardImgSrc = useCallback((img: string) =>
    img ? convertFileSrc(img.includes('://') ? (img.split('/').pop() || '') : img, 'boardimg') : '',
  []);

  // list-row title/snippet for the workspace (Notion-style)
  const rowTitle = useCallback((n: BoardNodeData) => {
    if ((n.customTitle || '').trim()) return (n.customTitle || '').trim();
    if (n.kind === 'reference') return 'Reference';
    const first = (n.text || '').split('\n').find((l) => l.trim());
    return (first ? htmlToText(first) : '').slice(0, 60) || 'Untitled note';
  }, []);
  const rowSnippet = useCallback((n: BoardNodeData) => {
    if (n.kind === 'reference') return 'Whole image — click to preview';
    const lines = (n.text || '').split('\n').filter((l) => l.trim());
    return htmlToText(lines.slice(1).join(' ') || lines[0] || '').slice(0, 120) || 'Empty note';
  }, []);

  const boardContext = useMemo(
    () => nodes
      .map((n, i) => `### Card ${i + 1}${(n.customTitle ?? '').trim() ? ' — ' + (n.customTitle ?? '').trim() : ''}\n${htmlToText(n.text || '')}`)
      .join('\n\n'),
    [nodes],
  );

  // every visible thing that an internal link can point to
  const linkTargets = useMemo<LinkTargetItem[]>(() =>
    nodes.map((n) => {
      const title = (n.customTitle ?? '').trim() || rowTitle(n);
      const sub =
        n.kind === 'reference' ? (n.image ? 'Image reference' : 'Empty image')
        : n.kind === 'node' ? 'Container'
        : n.kind === 'group' ? 'Group'
        : htmlToText(n.text || '').slice(0, 60) || 'Empty note';
      return { type: n.kind, id: n.id, label: title, sub };
    }),
  [nodes, rowTitle],
  );

  const sendBoardChat = useCallback(async (text: string) => {
    const prompt = (text || '').trim();
    if (!prompt || busyChat || !nodes.length || !currentBoardId) return;
    const userMsg: ChatMsg = { role: 'user', content: prompt };
    const history = [...(chats[currentBoardId] || []), userMsg];
    setChats((c) => ({ ...c, [currentBoardId]: history }));
    setChatDraft('');
    setBusyChat(true);
    try {
      const baseUrl = await getSidecarUrl();
      const res = await fetch(`${baseUrl}/api/board/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cards: boardContext, messages: history, cfg: getAiCfg() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || `Failed (${res.status})`);
      setChats((c) => ({ ...c, [currentBoardId]: [...history, { role: 'assistant', content: data.reply || '' }] }));
    } catch (err: any) {
      setChats((c) => ({ ...c, [currentBoardId]: [...history, { role: 'assistant', content: '⚠ ' + err.message }] }));
    } finally {
      setBusyChat(false);
    }
  }, [busyChat, chats, currentBoardId, nodes.length, boardContext]);

  useEffect(() => {
    if (chatOpen) chatScrollRef.current?.scrollTo({ top: chatScrollRef.current.scrollHeight });
  }, [chatOpen, chats, busyChat]);

  useEffect(() => {
    document.documentElement.setAttribute('data-palette', palette);
    localStorage.setItem('nt-palette', palette);
  }, [palette]);
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('nt-theme', theme);
  }, [theme]);

  useEffect(() => {
    listBoards().then((b) => {
      setBoards(b);
      if (b.length > 0) loadBoard(b[0].id);
    });
    useTagStore.getState().refresh();
  }, []);

  // switching boards closes any open workspace; deleting the container clears it
  useEffect(() => { setWorkspaceNodeId(null); }, [currentBoardId]);
  // restore this board's last view (board ⇄ table) — persisted per board
  useEffect(() => {
    setViewMode(localStorage.getItem('nt-viewmode-' + currentBoardId) === 'table' ? 'table' : 'board');
  }, [currentBoardId]);
  useEffect(() => {
    if (workspaceNodeId && !nodes.some((n) => n.id === workspaceNodeId)) setWorkspaceNodeId(null);
  }, [nodes, workspaceNodeId]);
  useEffect(() => { setWsTitleDraft(workspaceNode?.customTitle || ''); }, [workspaceNodeId, workspaceNode?.customTitle]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName) && !(e.target as HTMLElement).isContentEditable) setSpaceDown(true);
    };
    const up = (e: KeyboardEvent) => { if (e.code === 'Space') setSpaceDown(false); };
    document.addEventListener('keydown', down);
    document.addEventListener('keyup', up);
    return () => { document.removeEventListener('keydown', down); document.removeEventListener('keyup', up); };
  }, []);

  const worldStyle: React.CSSProperties = {
    transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
    transformOrigin: '0 0',
  };

  const screenToWorld = useCallback((clientX: number, clientY: number) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: (clientX - rect.left - view.x) / view.zoom, y: (clientY - rect.top - view.y) / view.zoom };
  }, [view]);

  const zoomAt = useCallback((factor: number, cx?: number, cy?: number) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = cx ?? rect.width / 2;
    const py = cy ?? rect.height / 2;
    const newZoom = Math.max(0.15, Math.min(4, view.zoom * factor));
    const rf = newZoom / view.zoom;
    setView({ x: px - (px - view.x) * rf, y: py - (py - view.y) * rf, zoom: newZoom });
  }, [view, setView]);

  const fitToView = useCallback(() => {
    if (!nodes.length) { setView({ x: 40, y: 40, zoom: 1 }); return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    nodes.forEach((n) => { minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x + n.w); maxY = Math.max(maxY, n.y + n.h); });
    const padding = 60;
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    const scale = Math.min((rect.width - padding * 2) / (maxX - minX), (rect.height - padding * 2) / (maxY - minY), 1.5);
    const zoom = Math.max(0.15, scale);
    setView({ zoom, x: (rect.width - (maxX - minX) * zoom) / 2 - minX * zoom, y: (rect.height - (maxY - minY) * zoom) / 2 - minY * zoom });
  }, [nodes, setView]);

  const openWorkspace = useCallback((nodeId: string) => {
    setWorkspaceNodeId(nodeId);
    setWsTitleDraft(nodes.find((n) => n.id === nodeId)?.customTitle || '');
    setWsAddDraft('');
  }, [nodes]);

  // internal links in notes navigate the app: open modal / preview / workspace / pan to group
  useEffect(() => {
    setInternalLinkHandler((target) => {
      const n = nodes.find((x) => x.id === target.id);
      if (!n) { toast('This link points to a card that was deleted.'); return; }
      if (n.kind === 'note') setModalNodeId(n.id);
      else if (n.kind === 'reference' && n.image) setPreview({ src: boardImgSrc(n.image) });
      else if (n.kind === 'node') openWorkspace(n.id);
      else if (n.kind === 'group') {
        const rect = viewportRef.current?.getBoundingClientRect();
        if (!rect) return;
        const zoom = view.zoom;
        setView({ zoom, x: rect.width / 2 - (n.x + n.w / 2) * zoom, y: rect.height / 2 - (n.y + n.h / 2) * zoom });
      }
    });
    return () => setInternalLinkHandler(null);
  }, [nodes, boardImgSrc, openWorkspace, setView, view.zoom]);

  // workspace helpers: quick-add note/reference children
  const addWsNote = useCallback((text = '') => {
    if (!workspaceNodeId) return;
    const n = addNode(60 + Math.random() * 40, 60 + displayed.length * 24, text, 'note', workspaceNodeId);
    if (!text) setModalNodeId(n.id);
  }, [workspaceNodeId, addNode, displayed.length]);
  const addWsRef = useCallback(() => {
    if (!workspaceNodeId) return;
    openImagePicker({ x: 60, y: 60 });
  }, [workspaceNodeId, openImagePicker]);

  // ---- drag a card over container cards: highlight + re-parent on drop ----
  const onNodeDragMove = useCallback((nodeId: string, clientX: number, clientY: number) => {
    if (inWs) return;
    const dragged = nodes.find((n) => n.id === nodeId);
    if (!dragged || dragged.kind === 'node') { // containers are never nested
      if (dragHoverIdRef.current !== null) { dragHoverIdRef.current = null; setDragHoverId(null); }
      return;
    }
    const p = screenToWorld(clientX, clientY);
    const target = nodes.find((n) =>
      n.kind === 'node' && n.id !== nodeId &&
      p.x >= n.x && p.x <= n.x + n.w && p.y >= n.y && p.y <= n.y + n.h,
    );
    const id = target?.id ?? null;
    if (dragHoverIdRef.current !== id) { dragHoverIdRef.current = id; setDragHoverId(id); }
  }, [inWs, nodes, screenToWorld]);

  const onNodeDragEnd = useCallback((nodeId: string, _x: number, _y: number, moved: boolean) => {
    const targetId = dragHoverIdRef.current;
    dragHoverIdRef.current = null;
    setDragHoverId(null);
    if (!moved || !targetId || targetId === nodeId) return;
    updateNode(nodeId, { parentId: targetId });
    scheduleSave();
    toast('Added to node.');
  }, [updateNode, scheduleSave]);

  const onViewportPointerDown = useCallback((e: React.PointerEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('.board-node') || target.closest('.edge-hit') || target.closest('.zoom-ctl')) return;
    if (e.button === 2) return;
    const forcePan = e.button === 1 || spaceDown;
    if (!e.shiftKey) clearSelection();
    const sx = e.clientX, sy = e.clientY;
    const ox = view.x, oy = view.y;
    const wpt0 = screenToWorld(e.clientX, e.clientY);
    const marqueeEnabled = !forcePan && tool === 'select';
    let marquee = false;
    let panned = false;
    let cur: { x1: number; y1: number; x2: number; y2: number } | null = null;

    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (!panned && !marquee && !forcePan && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
        if (marqueeEnabled) marquee = true; else panned = true;
        viewportRef.current?.classList.add('panning');
      }
      if (forcePan || panned) { setView({ x: ox + dx, y: oy + dy }); }
      if (marquee) {
        const p = screenToWorld(ev.clientX, ev.clientY);
        cur = { x1: wpt0.x, y1: wpt0.y, x2: p.x, y2: p.y };
        setSelRect(cur);
      }
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      viewportRef.current?.classList.remove('panning');
      if (marquee && cur) {
        setSelRect(null);
        const x1 = Math.min(cur.x1, cur.x2), y1 = Math.min(cur.y1, cur.y2);
        const x2 = Math.max(cur.x1, cur.x2), y2 = Math.max(cur.y1, cur.y2);
        const st = useBoardStore.getState();
        st.nodes.forEach((n) => {
          if (n.x < x2 && n.x + n.w > x1 && n.y < y2 && n.y + n.h > y1) {
            st.selectNode(n.id, e.shiftKey);
          }
        });
        return;
      }
      if (panned) scheduleSave();
      // Tools place on a clean click (no drag): note → add, image → picker.
      // The note tool places a single note, then falls back to select.
      else if (tool === 'note') { addNode(wpt0.x, wpt0.y, ''); setToolActive('select'); }
      else if (tool === 'reference') { openImagePicker(wpt0); }
      else if (tool === 'node') { addNode(wpt0.x, wpt0.y, '', 'node'); setToolActive('select'); }
      else if (tool === 'group') { addNode(wpt0.x, wpt0.y, '', 'group'); setToolActive('select'); }
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }, [view, spaceDown, clearSelection, setView, scheduleSave, tool, addNode, openImagePicker, screenToWorld, setToolActive]);

  const onViewportDoubleClick = useCallback((e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('.board-node')) return;
    const wpt = screenToWorld(e.clientX, e.clientY);
    addNode(wpt.x, wpt.y, '');
  }, [screenToWorld, addNode]);

  const onWheel = useCallback((e: React.WheelEvent) => {
    // Scrolling over a note scrolls the note's own content, never the board zoom.
    const scroller = (e.target as HTMLElement).closest('.node-body') as HTMLElement | null;
    if (scroller && scroller.scrollHeight > scroller.clientHeight) return;
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    zoomAt(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - rect.left, e.clientY - rect.top);
  }, [zoomAt]);

  // right-click context menu
  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    if (inWs) return; // workspace is a list — rows have their own actions
    const nodeEl = (e.target as HTMLElement).closest('.board-node');
    const wpt = screenToWorld(e.clientX, e.clientY);
    const iconOpen = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" /></svg>;
    const iconImg = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-5-5L5 21" /></svg>;
    const iconEye = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.35-4.35M8 11h6M11 8v6" /></svg>;
    const iconPencil = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /></svg>;
    const iconConnect = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="5" cy="12" r="2" /><circle cx="19" cy="12" r="2" /><path d="M7 12h10" /></svg>;
    const iconDup = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>;
    const iconDel = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M6 6l12 12M18 6 6 18" /></svg>;
    if (nodeEl) {
      const nid = nodeEl.getAttribute('data-id') || '';
      const n = nodes.find((x) => x.id === nid);
      selectNode(nid);
      const items: CtxItem[] = [];
      if (n?.kind === 'node') {
        items.push(
          { label: 'Open node', icon: iconOpen, action: () => openWorkspace(nid) },
          { label: 'Rename node…', icon: iconPencil, action: async () => {
            const name = await showPrompt({ title: 'Rename node', initial: n.customTitle || '', placeholder: 'Node name' });
            if (name && name.trim()) updateNode(nid, { customTitle: name.trim() });
          } },
          { sep: true },
          { label: 'Duplicate', icon: iconDup, action: () => duplicateNode(nid) },
          { sep: true },
          { label: 'Delete', danger: true, icon: iconDel, action: () => deleteNode(nid) },
        );
      } else if (n?.kind === 'group') {
        items.push(
          { label: 'Rename group…', icon: iconPencil, action: async () => {
            const name = await showPrompt({ title: 'Rename group', initial: n.customTitle || '', placeholder: 'Group name' });
            if (name && name.trim()) updateNode(nid, { customTitle: name.trim() });
          } },
          { sep: true },
          { label: 'Duplicate', icon: iconDup, action: () => duplicateNode(nid) },
          { sep: true },
          { label: 'Delete', danger: true, icon: iconDel, action: () => deleteNode(nid) },
        );
      } else if (n?.kind === 'reference') {
        if (n.image) items.push({ label: 'Preview image', icon: iconEye, action: () => setPreview({ src: boardImgSrc(n.image as string) }) });
        items.push(
          { label: 'Replace image…', icon: iconImg, action: () => openImagePickerForNode(nid) },
          { label: 'Connect from here…', icon: iconConnect, action: () => { selectNode(nid); setToolActive('connect'); toast('Grab a node edge and drag to another note.'); } },
          { label: 'Duplicate', icon: iconDup, action: () => duplicateNode(nid) },
          { sep: true },
          { label: 'Delete', danger: true, icon: iconDel, action: () => deleteNode(nid) },
        );
      } else {
        if (n?.image) items.push({ label: 'Preview image', icon: iconEye, action: () => setPreview({ src: boardImgSrc(n.image as string) }) });
        items.push(
          { label: 'Open in focus mode', icon: iconOpen, action: () => setModalNodeId(nid) },
          { label: n?.image ? 'Replace note image…' : 'Add image to note…', icon: iconImg, action: () => openImagePickerForNode(nid) },
          { label: 'Connect from here…', icon: iconConnect, action: () => { selectNode(nid); setToolActive('connect'); toast('Grab a node edge and drag to another note.'); } },
          { label: 'Duplicate', icon: iconDup, action: () => duplicateNode(nid) },
          { sep: true },
          { label: 'Delete', danger: true, icon: iconDel, action: () => deleteNode(nid) },
        );
      }
      setCtxMenu({ x: e.clientX, y: e.clientY, items });
    } else {
      const items: CtxItem[] = [
        { label: 'Add note here', icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 5v14M5 12h14" /></svg>, action: () => addNode(wpt.x, wpt.y, '') },
        { label: 'Add reference here', icon: iconImg, action: () => openImagePicker(wpt) },
        { label: 'Add node here', icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /><path d="M12 11v4M10 13h4" /></svg>, action: () => addNode(wpt.x, wpt.y, '', 'node') },
        { label: 'Add group here', icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="4" y="4" width="16" height="16" rx="2" strokeDasharray="3 2" /><path d="M9 4v16M15 4v16M4 9h16M4 15h16" /></svg>, action: () => addNode(wpt.x, wpt.y, '', 'group') },
      ];
      items.push(
        { sep: true },
        { label: 'Arrange all', icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>, action: arrangeNodes },
        { label: 'Fit view', icon: iconOpen, action: fitToView },
        { sep: true },
        { label: 'New board…', icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 5v14M5 12h14" /></svg>, action: handleCreateBoard },
      );
      setCtxMenu({ x: e.clientX, y: e.clientY, items });
    }
  }, [screenToWorld, selectNode, nodes, updateNode, deleteNode, addNode, duplicateNode, openImagePicker, openImagePickerForNode, openWorkspace, arrangeNodes, fitToView, boardImgSrc]);


  // auto-layout
  function arrangeNodes() {
    const cols = Math.ceil(Math.sqrt(nodes.length));
    nodes.forEach((n, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      updateNode(n.id, { x: col * 300 + 40, y: row * 220 + 40 });
    });
    scheduleSave();
    setTimeout(() => fitToView(), 50);
  }

  // Esc closes modal / context menu and drops the active tool
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setModalNodeId(null);
        setCtxMenu(null);
        setProvisional(null);
        setSelRect(null);
        setPreview(null);
        setToolActive('select');
      }
    };
    document.addEventListener('keydown', onEsc);
    return () => document.removeEventListener('keydown', onEsc);
  }, []);

  // tool keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (['INPUT', 'TEXTAREA'].includes(el.tagName) || el.isContentEditable) return;
      // board-level undo/redo (Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y)
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
        if (k === 'y') { e.preventDefault(); redo(); return; }
      }
      const map: Record<string, Tool> = { v: 'select', n: 'note', i: 'reference', r: 'reference', g: 'node', f: 'group', c: 'connect' };
      const t = viewMode === 'table' ? undefined : map[e.key.toLowerCase()];
      if (t) setToolActive(t);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [undo, redo, viewMode]);

  // load the deleted-notes history on startup
  useEffect(() => {
    loadTrash();
  }, [loadTrash]);

  async function handleCreateBoard() {
    const name = await showPrompt({ title: 'New board', initial: 'New board', placeholder: 'Board name' });
    if (!name || !name.trim()) return;
    const board = await createBoard(name.trim());
    setBoards(await listBoards());
    loadBoard(board.id);
  }
  async function handleDeleteBoard(id: string, name: string) {
    const ok = await showConfirm('Delete board', `Delete "${name}" and all its nodes?`);
    if (!ok) return;
    await deleteBoard(id);
    const updated = await listBoards();
    setBoards(updated);
    if (updated.length > 0) loadBoard(updated[0].id);
  }
  async function handleRenameBoard(id: string, currentName: string) {
    const name = await showPrompt({ title: 'Rename board', initial: currentName, placeholder: 'Board name' });
    if (!name || !name.trim()) return;
    await renameBoard(id, name.trim());
    setBoards(await listBoards());
  }
  function cyclePalette() { const idx = PALETTES.indexOf(palette as any); setPalette(PALETTES[(idx + 1) % PALETTES.length]); }
  function toggleTheme() { setTheme(theme === 'dark' ? 'light' : 'dark'); }
  async function openBoard(boardId: string, nodeId?: string) {
    setScreen('board');
    await loadBoard(boardId);
    setBoards(await listBoards());
    if (nodeId) selectNode(nodeId);
  }
  // open a note directly in focus mode (modal) — stays in the Library view
  async function openFocusNote(boardId: string, nodeId: string) {
    await loadBoard(boardId);
    setModalNodeId(nodeId);
  }

  function setToolActive(t: Tool) {
    setTool(t);
    document.body.className = 'tool-' + t;
    if (t !== 'connect') setProvisional(null);
  }

  function switchView(m: 'board' | 'table') {
    setViewMode(m);
    if (currentBoardId) localStorage.setItem('nt-viewmode-' + currentBoardId, m);
  }

  // kind-aware open action for table rows
  const openBoardNode = useCallback((n: BoardNodeData) => {
    selectNode(n.id);
    if (n.kind === 'reference') { if (n.image) setPreview({ src: boardImgSrc(n.image as string) }); }
    else if (n.kind === 'node') openWorkspace(n.id);
    else if (n.kind === 'note') setModalNodeId(n.id);
  }, [selectNode, boardImgSrc, openWorkspace]);

  // new cards created from the table land on the board in a grid, clear of overlap
  const tableSpot = useCallback(() => {
    const root = nodes.filter((n) => !(n.parentId ?? null));
    const i = root.length;
    return { x: 60 + (i % 4) * 340, y: 60 + Math.floor(i / 4) * 280 };
  }, [nodes]);
  const addTableNote = useCallback((text = '') => {
    const pt = tableSpot();
    const n = addNode(pt.x, pt.y, text, 'note');
    if (!text) setModalNodeId(n.id);
  }, [tableSpot, addNode]);
  const addTableRef = useCallback(() => {
    openImagePicker(tableSpot());
  }, [tableSpot]);

  // Drag-from-a-node to connect (like the old app): pointerdown on a node in
  // connect mode draws a provisional edge; release over another node to link.
  const startConnect = useCallback((nodeId: string, e: React.PointerEvent) => {
    e.preventDefault();
    const from = nodes.find((n) => n.id === nodeId);
    if (!from) return;
    document.body.classList.add('connecting');
    const startPt = { x: from.x + from.w / 2, y: from.y + from.h / 2 };
    const wpt = screenToWorld(e.clientX, e.clientY);
    setProvisional({ x1: startPt.x, y1: startPt.y, x2: wpt.x, y2: wpt.y });
    const move = (ev: PointerEvent) => {
      const p = screenToWorld(ev.clientX, ev.clientY);
      setProvisional((prev) => (prev ? { ...prev, x2: p.x, y2: p.y } : prev));
    };
    const up = (ev: PointerEvent) => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      setProvisional(null);
      document.body.classList.remove('connecting');
      const p = screenToWorld(ev.clientX, ev.clientY);
      const target = nodes.find(
        (n) => n.id !== nodeId && p.x >= n.x && p.x <= n.x + n.w && p.y >= n.y && p.y <= n.y + n.h,
      );
      if (target) {
        addEdge(nodeId, target.id);
        toast('Connected.');
      }
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }, [nodes, screenToWorld, addEdge]);

  // Open the hidden file picker and remember where the image should land.
  function openImagePicker(wpt: { x: number; y: number }, parentId: string | null = null) {
    imageDropPtRef.current = wpt;
    imageDropParentRef.current = parentId ?? workspaceNodeId;
    imageInputRef.current?.click();
  }

  // Quick-add a card straight into a group (container node)
  const addToContainer = useCallback((nodeId: string, kind: 'note' | 'reference') => {
    if (kind === 'note') {
      const n = addNode(60 + Math.random() * 60, 60 + Math.random() * 60, '', 'note', nodeId);
      setModalNodeId(n.id);
    } else {
      openImagePicker({ x: 60, y: 60 }, nodeId);
    }
  }, [addNode]);

  // Open the picker for an existing node (replaces the note's image).
  function openImagePickerForNode(nodeId: string) {
    imageDropNodeRef.current = nodeId;
    imageInputRef.current?.click();
  }

  // Save an image file and drop it as a new reference (or into an existing node).
  const addImageFile = useCallback(async (f: File, pt: { x: number; y: number }, nodeId: string | null, parentId: string | null = null) => {
    const ext = '.' + ((f.name.split('.').pop() || '').toLowerCase());
    if (!['.png', '.jpg', '.jpeg', '.jfif', '.gif', '.webp', '.bmp', '.svg', '.ico', '.tif', '.tiff', '.avif'].includes(ext)) {
      toast('Unsupported image type.');
      return;
    }
    const buf = new Uint8Array(await f.arrayBuffer());
    if (buf.length > 8 * 1024 * 1024) { toast('Image too large (max 8 MB).'); return; }
    try {
      const { id } = await saveBoardImage(buf, ext);
      if (nodeId && nodes.some((n) => n.id === nodeId)) {
        updateNode(nodeId, { image: id });
        toast('Image added to note.');
      } else {
        const node = addNode(pt.x, pt.y, '', 'reference', parentId);
        updateNode(node.id, { image: id, w: 460, h: 320 });
        toast('Image added.');
      }
    } catch (err: any) {
      toast(String(err.message || err));
    }
  }, [nodes, addNode, updateNode]);

  const onImagePicked = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    const pt = imageDropPtRef.current || { x: 60, y: 60 };
    const nodeId = imageDropNodeRef.current;
    const parentId = imageDropParentRef.current;
    imageDropPtRef.current = null;
    imageDropNodeRef.current = null;
    imageDropParentRef.current = null;
    await addImageFile(f, pt, nodeId, parentId);
  }, [addImageFile]);

  // drag & drop image files from the OS onto the board.
  // Uses the window-level drag-drop events (reliable in WebView2; HTML5
  // drag events don't fire for external files). Requires dragDropEnabled.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWindow().onDragDropEvent(async (event) => {
      const payload = event.payload;
      if (payload.type === 'enter' || payload.type === 'over') {
        setDragOverFile(true);
      } else if (payload.type === 'leave') {
        setDragOverFile(false);
      } else if (payload.type === 'drop') {
        setDragOverFile(false);
        const key = JSON.stringify(payload.paths);
        const now = Date.now();
        if (now - lastDropRef.current.t < 800 && lastDropRef.current.key === key) return;
        lastDropRef.current = { t: now, key };
        const scale = window.devicePixelRatio || 1;
        const wpt = screenToWorld(payload.position.x / scale, payload.position.y / scale);
        const parentId = workspaceNodeId;
        let added = 0;
        for (let i = 0; i < payload.paths.length; i++) {
          const p = payload.paths[i];
          if (!/\.(png|jpe?g|jfif|gif|webp|bmp|svg|ico|tiff?|avif)$/i.test(p)) continue;
          try {
            const { id } = await saveBoardImageFromPath(p);
            const pt = inWs ? { x: 60 + i * 24, y: 60 + i * 24 } : { x: wpt.x + i * 24, y: wpt.y + i * 24 };
            const node = addNode(pt.x, pt.y, '', 'reference', parentId);
            updateNode(node.id, { image: id, w: 460, h: 320 });
            added++;
          } catch (err: any) {
            toast(String(err.message || err));
          }
        }
        if (added > 0) toast(inWs ? 'Image added to node.' : 'Image added.');
      }
    }).then((fn) => { unlisten = fn; }).catch(() => {});
    return () => { unlisten?.(); };
  }, [inWs, screenToWorld, addNode, updateNode, workspaceNodeId]);

  // paste images (Ctrl+V) from the clipboard onto the board. Skipped while
  // typing in an editor/input so text paste is never hijacked.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, [contenteditable="true"]')) return;
      const cd = e.clipboardData;
      if (!cd) return;
      const file = Array.from(cd.files || []).find((f) => /^image\//.test(f.type));
      const item = !file ? Array.from(cd.items || []).find((it) => it.type.startsWith('image/')) : undefined;
      const img = file ?? item?.getAsFile();
      if (!img) return;
      e.preventDefault();
      (async () => {
      const f = img instanceof File && img.name
        ? img
        : new File([img as Blob], 'pasted.' + imageExtFor('', img.type), { type: img.type });
        let pt: { x: number; y: number } | null = null;
        if (inWs) {
          pt = { x: 60, y: 60 };
        } else if (lastMouseRef.current) {
          pt = screenToWorld(lastMouseRef.current.x, lastMouseRef.current.y);
        } else if (viewportRef.current) {
          const r = viewportRef.current.getBoundingClientRect();
          pt = screenToWorld(r.left + r.width / 2, r.top + r.height / 2);
        }
        if (!pt) return;
        await addImageFile(f, pt, null, workspaceNodeId);
      })();
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [inWs, screenToWorld, addImageFile, workspaceNodeId]);

  const currentBoard = boards.find((b) => b.id === currentBoardId);
  const boardTags = [...new Set(nodes.flatMap((n) => n.tags || []))];
  const hist = history[currentBoardId] || { past: [], future: [] };
  const canUndo = hist.past.length > 0;
  const canRedo = hist.future.length > 0;

  // Export the board as an AI-friendly Markdown document (preview + copy + save)
  const exportBoard = useCallback(() => {
    if (!currentBoard) return;
    const md = buildBoardMarkdown(currentBoard.name, nodes, edges);
    showCustom('Export board as Markdown', (close) => (
      <div className="export-body">
        <textarea className="export-preview" readOnly value={md} spellCheck={false} />
        <div className="dialog-actions">
          <button
            className="btn btn-ghost"
            onClick={() => { navigator.clipboard.writeText(md); toast('Markdown copied to clipboard.'); }}
          >
            Copy
          </button>
          <button
            className="btn btn-primary"
            onClick={async () => {
              try {
                const path = await saveMarkdownExport(currentBoard.name, md);
                close();
                toast('Saved: ' + path);
              } catch (e) {
                toast('Export failed: ' + e);
              }
            }}
          >
            Save &amp; open
          </button>
        </div>
      </div>
    ));
  }, [currentBoard, nodes, edges]);

  function trashTitle(e: TrashEntry) {
    try {
      const n = JSON.parse(e.data) as BoardNodeData;
      if ((n.customTitle || '').trim()) return (n.customTitle as string).trim();
      const line = (n.text || '').split('\n').find((l: string) => l.trim());
      return htmlToText(line || '').slice(0, 60) || 'Untitled note';
    } catch {
      return 'Untitled note';
    }
  }
  function trashMeta(e: TrashEntry) {
    const bn = boards.find((b) => b.id === e.boardId)?.name || 'Unknown board';
    const d = new Date(e.deletedAt);
    const when = Number.isNaN(d.getTime())
      ? ''
      : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `${bn} · deleted ${when}`.trim();
  }
  const selectedNote = nodes.find((n) => selectedIds.size === 1 && selectedIds.has(n.id));
  const crumbLabel =
    screen === 'board'
      ? selectedNote
        ? (selectedNote.customTitle || '').trim() || (selectedNote.text || '').split('\n')[0].trim() || 'Untitled note'
        : currentBoard?.name || ''
      : screen === 'capture' || screen === 'settings'
        ? screen === 'capture' ? 'Capture' : 'Settings'
        : 'Library';
  let svgW = 2000, svgH = 2000;
  nodes.forEach((n) => { svgW = Math.max(svgW, n.x + n.w + 400); svgH = Math.max(svgH, n.y + n.h + 400); });

  return (
    <div className="app">
      <div className="titlebar" data-tauri-drag-region>
        <div className="titlebar-left"><span className="brand-mark" /><span className="brand-name">note·taker</span></div>
        <span className="tb-crumb">
          {screen === 'capture' || screen === 'settings' ? 'Tools / ' : screen === 'library' ? 'Browse / ' : 'Board / '}
          <b>{crumbLabel}</b>
        </span>
        <div className="titlebar-spacer" />
        {updater.state.status === 'available' ? (
          <button className="titlebar-btn update-btn" onClick={updater.openDialog} title={`v${updater.state.version} is available — click to review and update`}>
            <span>Update available</span>
            <svg className="update-arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
          </button>
        ) : (
          <button
            className={`titlebar-btn update-check${updater.state.status === 'checking' ? ' spinning' : ''}`}
            onClick={() => updater.checkNow(true)}
            disabled={updater.state.status === 'checking'}
            title={updater.state.status === 'checking' ? 'Checking for updates…' : 'Check for updates'}
          >
            {updater.state.status === 'checking' ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M21 12a9 9 0 1 1-2.6-6.3" /></svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></svg>
            )}
          </button>
        )}
        <button className="titlebar-btn" onClick={cyclePalette} title="Switch palette"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9" /><path d="M12 3a9 9 0 0 0 0 18" fill="currentColor" /></svg></button>
        <button className="titlebar-btn" onClick={toggleTheme} title="Toggle theme"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg></button>
        <div className="winctl">
          <button onClick={() => minimizeWindow()}><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M5 12h14" /></svg></button>
          <button onClick={() => toggleMaximize()}><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="5" y="5" width="14" height="14" rx="1.5" /></svg></button>
          <button className="close" onClick={() => closeWindow()}><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M6 6l12 12M18 6 6 18" /></svg></button>
        </div>
      </div>

      <div className="shell">
        <nav className="sidebar">
          <div className="brand"><span className="brand-mark" /><div><span className="brand-name">note·taker</span><span className="brand-sub">local · private</span></div></div>
          <div className="nav">
            <span className="nav-label">Boards</span>
            {boards.map((b) => (
              <a key={b.id} href="#" className={`nav-item board-item ${b.id === currentBoardId ? 'active' : ''}`}
                onClick={(e) => { e.preventDefault(); setScreen('board'); loadBoard(b.id); }}
                onDoubleClick={() => handleRenameBoard(b.id, b.name)}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>
                <span className="board-label">{b.name}</span>
                <button className="board-del" onClick={(e) => { e.stopPropagation(); e.preventDefault(); handleDeleteBoard(b.id, b.name); }}><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 6l12 12M18 6 6 18" /></svg></button>
              </a>
            ))}
            <a href="#" className="nav-item" onClick={(e) => { e.preventDefault(); handleCreateBoard(); }}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M12 5v14M5 12h14" /></svg> New board</a>
            <span className="nav-label">Tools</span>
            <span className={`nav-item ${screen === 'library' ? 'active' : ''}`} onClick={() => setScreen('library')} style={{ cursor: 'pointer' }}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.35-4.35" /></svg> Library</span>
            <span className={`nav-item ${screen === 'capture' ? 'active' : ''}`} onClick={() => setScreen('capture')} style={{ cursor: 'pointer' }}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3Z" /><path d="M19 10v1a7 7 0 0 1-14 0v-1" /></svg> Capture</span>
            <span className={`nav-item ${screen === 'settings' ? 'active' : ''}`} onClick={() => setScreen('settings')} style={{ cursor: 'pointer' }}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" /></svg> Settings</span>
          </div>
          <div className="sidebar-foot"><span className="foot-meta">local · private<br />v3.0 · tauri build</span></div>
        </nav>

        <main className="main">
          {screen === 'library' ? (
            <Library onOpenBoard={openBoard} onOpenFocus={openFocusNote} />
          ) : screen === 'capture' ? (
            <Capture onOpenBoard={openBoard} onBoardCreated={() => { listBoards().then(setBoards).catch(() => {}); }} />
          ) : screen === 'settings' ? (
            <div className="scroll" style={{ flex: 1, overflowY: 'auto' }}>
              <Settings palette={palette} theme={theme} onPalette={setPalette} onTheme={setTheme} />
            </div>
          ) : (
          <>
          {inWs ? (
          <div className="ws-wrap">
            <div className="ws-toolbar">
              <button className="btn btn-ghost btn-sm" onClick={() => setWorkspaceNodeId(null)} title="Back to board">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 12H5M11 18l-6-6 6-6" /></svg>
                Board
              </button>
              <svg className="ws-kind-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></svg>
              <input
                className="ws-title-input"
                value={wsTitleDraft}
                placeholder="Untitled node"
                onChange={(e) => setWsTitleDraft(e.target.value)}
                onBlur={() => { const v = wsTitleDraft.trim(); if (v && workspaceNodeId) updateNode(workspaceNodeId, { customTitle: v }); }}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              />
              <span className="ws-count">{displayed.length} {displayed.length === 1 ? 'item' : 'items'}</span>
              <div className="grow" />
              <button className="btn btn-primary btn-sm" onClick={() => addWsNote('')}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14" /></svg>
                Add note
              </button>
              <button className="btn btn-ghost btn-sm" onClick={addWsRef}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-5-5L5 21" /></svg>
                Add reference
              </button>
              <button className="btn btn-ghost btn-sm" onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"><path d="M9 14 4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" /></svg>
              </button>
              <button className="btn btn-ghost btn-sm" onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"><path d="m15 14 5-5-5-5" /><path d="M20 9H10a6 6 0 0 0 0 12h3" /></svg>
              </button>
            </div>
            <div className="ws-list">
              {displayed.length === 0 ? (
                <div className="ws-empty">
                  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></svg>
                  <p>This node is empty</p>
                  <span className="hint">Add notes, or drag cards from the board onto the node</span>
                  <div className="ws-empty-actions">
                    <button className="btn btn-primary btn-sm" onClick={() => addWsNote('')}>Add a note</button>
                    <button className="btn btn-ghost btn-sm" onClick={addWsRef}>Add a reference</button>
                  </div>
                </div>
              ) : (
                displayed.map((n) => (
                  <div key={n.id} className={`ws-row kind-${n.kind}`}>
                    <span className="ws-row-icon">
                      {n.kind === 'reference' ? (
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-5-5L5 21" /></svg>
                      ) : (
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" /><path d="M8 8h8M8 12h8M8 16h5" /></svg>
                      )}
                    </span>
                    <div className="ws-row-main">
                      <span className="ws-row-title">{rowTitle(n)}</span>
                      <span className="ws-row-snippet">{rowSnippet(n)}</span>
                      {(n.tags || []).length > 0 && (
                        <span className="ws-row-tags">
                          {(n.tags || []).map((t) => (
                            <span key={t} className="tag-chip c-tag" style={tagChipStyle({ name: t })}>{t}</span>
                          ))}
                        </span>
                      )}
                    </div>
                    {n.kind === 'reference' && n.image && (
                      <img className="ws-row-thumb" src={boardImgSrc(n.image as string)} draggable={false} alt="" />
                    )}
                    <div className="ws-row-actions">
                      <button className="ws-row-btn" title={n.kind === 'reference' ? 'Preview image' : 'Open note'} onClick={() => { if (n.kind === 'reference') { if (n.image) setPreview({ src: boardImgSrc(n.image as string) }); } else setModalNodeId(n.id); }}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" /></svg>
                      </button>
                      <button className="ws-row-btn" title="Move back to board" onClick={() => { updateNode(n.id, { parentId: null }); scheduleSave(); }}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 12h13M11 7l5 5-5 5" /><path d="M17 3h1a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3h-1" /></svg>
                      </button>
                      <button className="ws-row-btn del" title="Delete" onClick={() => deleteNode(n.id)}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 6l12 12M18 6 6 18" /></svg>
                      </button>
                    </div>
                  </div>
                ))
              )}
              <div className="ws-add-row">
                <input
                  className="ws-add-input"
                  placeholder="Type a note and press Enter to add…"
                  value={wsAddDraft}
                  onChange={(e) => setWsAddDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && wsAddDraft.trim()) {
                      addWsNote(wsAddDraft.trim());
                      setWsAddDraft('');
                    }
                  }}
                />
              </div>
            </div>
          </div>
          ) : (
          <>
          <div className="board-toolbar">
            <div className="view-switch">
              <button className={viewMode === 'board' ? 'active' : ''} onClick={() => switchView('board')} title="Board view — infinite canvas">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M9 21V9" /></svg>
                Board
              </button>
              <button className={viewMode === 'table' ? 'active' : ''} onClick={() => switchView('table')} title="Table view — database-style list">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M3 15h18M9 3v18" /></svg>
                Table
              </button>
            </div>
            {viewMode === 'board' && (
            <>
            <div className="tool-bar">
              <button className={`tool ${tool === 'select' ? 'active' : ''}`} title="Select / pan (V)" onClick={() => setToolActive('select')}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m3 3 7.5 18 2.7-7.8L21 10.5z" /></svg></button>
              <button className={`tool ${tool === 'note' ? 'active' : ''}`} title="Add note (N)" onClick={() => setToolActive('note')}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 5v14M5 12h14" /></svg></button>
              <button className={`tool ${tool === 'reference' ? 'active' : ''}`} title="Add reference — whole image (R)" onClick={() => setToolActive('reference')}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-5-5L5 21" /></svg></button>
              <button className={`tool ${tool === 'node' ? 'active' : ''}`} title="Add node — container (G)" onClick={() => setToolActive('node')}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></svg></button>
              <button className={`tool ${tool === 'group' ? 'active' : ''}`} title="Add group — layout box (F)" onClick={() => setToolActive('group')}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="4" y="4" width="16" height="16" rx="2" strokeDasharray="3 2" /><path d="M9 4v16M15 4v16M4 9h16M4 15h16" /></svg></button>
            </div>
            <button className="btn btn-ghost btn-sm" onClick={arrangeNodes} title="Arrange nodes in a grid">Arrange</button>
            <button className="btn btn-ghost btn-sm" onClick={fitToView} title="Fit all nodes">Fit</button>
            </>
            )}
            <button className="btn btn-ghost btn-sm" onClick={exportBoard} title="Export the board as Markdown (great for pasting into an AI)">Export</button>
            <button className="btn btn-ghost btn-sm" onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"><path d="M9 14 4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" /></svg>
            </button>
            <button className="btn btn-ghost btn-sm" onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"><path d="m15 14 5-5-5-5" /><path d="M20 9H10a6 6 0 0 0 0 12h3" /></svg>
            </button>
            <div className="grow" />
            {boardTags.length > 0 && (
              <div className="board-tags">
                <button className={`tag-chip ${tagFilter === null ? 'active' : ''}`} onClick={() => setTagFilter(null)} title="Show all notes">All</button>
                {boardTags.map((t) => (
                  <button key={t} className={`tag-chip c-tag ${tagFilter === t ? 'active' : ''}`} style={tagChipStyle({ name: t })} onClick={() => setTagFilter(tagFilter === t ? null : t)} title={`Filter by #${t}`}>
                    {t}
                  </button>
                ))}
              </div>
            )}
            <button
              className={`btn btn-sm ${chatOpen ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setChatOpen((o) => !o)}
              title="Chat with AI about this board"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" /></svg>
              {chatOpen ? 'Close AI' : 'Ask AI'}
            </button>
            <button
              className={`btn btn-sm ${trashOpen ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setTrashOpen((o) => !o)}
              title="Deleted notes"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M10 11v6M14 11v6" /></svg>
              Trash
              {trash.length > 0 && <span className="badge-count">{trash.length}</span>}
            </button>
            <span className="board-count">{displayed.length} {displayed.length === 1 ? 'note' : 'notes'}</span>
          </div>

          <div className="board-stage">
          {viewMode === 'table' ? (
            <BoardTable
              boardId={currentBoardId}
              nodes={displayed}
              selectedId={selectedIds.size === 1 ? [...selectedIds][0] : null}
              imgSrc={boardImgSrc}
              rowTitle={rowTitle}
              rowSnippet={rowSnippet}
              onOpen={openBoardNode}
              onRename={(id, title) => updateNode(id, { customTitle: title })}
              onDelete={deleteNode}
              onAddNote={addTableNote}
              onAddRef={addTableRef}
            />
          ) : (
          <div
            className={`board-viewport ${dragOverFile ? 'drag-file' : ''}`}
            ref={viewportRef}
            onPointerDown={onViewportPointerDown}
            onDoubleClick={onViewportDoubleClick as any}
            onWheel={onWheel}
            onContextMenu={onContextMenu}
            onMouseMove={(e) => { lastMouseRef.current = { x: e.clientX, y: e.clientY }; }}
          >
            <div className="board-world" style={worldStyle}>
              <svg className="edge-layer" width={svgW} height={svgH}>
                {provisional && (
                  <line
                    className="edge-provisional"
                    x1={provisional.x1} y1={provisional.y1}
                    x2={provisional.x2} y2={provisional.y2}
                  />
                )}
                {edges.map((edge) => (<BoardEdge key={edge.id} edge={edge} nodes={nodes} onDelete={deleteEdge} />))}
              </svg>
              {displayed.map((node) => (
                <BoardNode
                  key={node.id}
                  node={node}
                  zoom={view.zoom}
                  linkTargets={linkTargets}
                  onConnectStart={startConnect}
                  onPreview={(src) => setPreview({ src })}
                  onOpenWorkspace={openWorkspace}
                  onAddImage={openImagePickerForNode}
                  onAddChild={addToContainer}
                  contained={childrenOf(node.id)}
                  onDragMove={onNodeDragMove}
                  onDragEnd={onNodeDragEnd}
                  dropTarget={dragHoverId === node.id}
                />
              ))}
              {selRect && (
                <div className="selection-rect" style={{
                  left: Math.min(selRect.x1, selRect.x2),
                  top: Math.min(selRect.y1, selRect.y2),
                  width: Math.abs(selRect.x2 - selRect.x1),
                  height: Math.abs(selRect.y2 - selRect.y1),
                }} />
              )}
              {displayed.length === 0 && (
                <div className="board-empty"><p>Double-click anywhere to add a note</p></div>
              )}
            </div>
            <div className="zoom-ctl">
              <button className="zoom-btn" onClick={() => zoomAt(1.2)}>+</button>
              <span className="zoom-label">{Math.round(view.zoom * 100)}%</span>
              <button className="zoom-btn" onClick={() => zoomAt(1 / 1.2)}>−</button>
              <button className="zoom-btn" onClick={fitToView} style={{ fontSize: '0.7rem' }}>⤢</button>
            </div>
          </div>
          )}

          {chatOpen && (
            <div className="board-chat" onPointerDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.stopPropagation()}>
              <div className="chat-head">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ color: 'var(--accent)' }}><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" /></svg>
                <span className="chat-title">Ask the board</span>
                <button className="chat-close" onClick={() => setChatOpen(false)} title="Close"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 6l12 12M18 6 6 18" /></svg></button>
              </div>
              <div className="chip-row">
                {BOARD_CHIPS.map((c) => (
                  <button key={c.label} className="chip" disabled={!nodes.length || busyChat} onClick={() => sendBoardChat(c.prompt)}>
                    {c.label}
                  </button>
                ))}
              </div>
              <div className="chat-wrap">
                <div className="chat-scroll" ref={chatScrollRef}>
                  {!nodes.length ? (
                    <div className="ai-empty">Add notes to the board first, then ask anything about them.</div>
                  ) : (chats[currentBoardId] || []).length === 0 ? (
                    <div className="ai-empty">Ready — ask a question about this board's notes.</div>
                  ) : (
                    (chats[currentBoardId] || []).map((m, i) => (
                      m.role === 'user' ? (
                        <div key={i} className="msg user">{m.content}</div>
                      ) : (
                        <div key={i} className="msg bot">
                          <span className="msg-role">Note taker</span>
                          <span dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }} />
                        </div>
                      )
                    ))
                  )}
                  {busyChat && <div className="msg bot"><span className="msg-role">Note taker</span>…</div>}
                </div>
                <div className="chat-input-row">
                  <input
                    className="input"
                    placeholder={nodes.length ? 'Ask about this board…' : 'Add notes first'}
                    value={chatDraft}
                    disabled={!nodes.length || busyChat}
                    onChange={(e) => setChatDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') sendBoardChat(chatDraft); }}
                  />
                  <button className="btn btn-primary" disabled={!nodes.length || busyChat} onClick={() => sendBoardChat(chatDraft)} aria-label="Send">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4Z" /></svg>
                  </button>
                </div>
              </div>
            </div>
          )}
          {trashOpen && (
            <div className={`board-chat trash-panel ${chatOpen ? 'offset' : ''}`} onPointerDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.stopPropagation()}>
              <div className="chat-head">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ color: 'var(--accent)' }}><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M10 11v6M14 11v6" /></svg>
                <span className="chat-title">Deleted notes</span>
                <span className="hint" style={{ marginLeft: 'auto' }}>{trash.length}</span>
                <button className="chat-close" onClick={() => setTrashOpen(false)} title="Close"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 6l12 12M18 6 6 18" /></svg></button>
              </div>
              <div className="chat-scroll">
                {trash.length === 0 ? (
                  <div className="ai-empty">Deleted notes land here, so nothing is ever truly gone. Restore them any time.</div>
                ) : (
                  trash.map((e) => (
                    <div key={e.id} className="trash-row">
                      <div className="trash-info">
                        <span className="trash-title">{trashTitle(e)}</span>
                        <span className="trash-meta">{trashMeta(e)}</span>
                      </div>
                      <div className="trash-actions">
                        <button className="btn btn-primary btn-sm" onClick={() => { restoreFromTrash(e.id); }}>Restore</button>
                        <button className="trash-discard" title="Delete forever" onClick={() => discardTrashEntry(e.id)}>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 6l12 12M18 6 6 18" /></svg>
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
          </div>
          </>
          )}
          </>
          )}
        </main>
      </div>

      {/* Hidden file picker for board images */}
      <input
        ref={imageInputRef}
        type="file"
        accept=".png,.jpg,.jpeg,.jfif,.gif,.webp,.bmp,.svg,.ico,.tif,.tiff,.avif"
        hidden
        onChange={onImagePicked}
      />

      {/* Modal note editor */}
      {modalNodeId && (
        <NoteModal key={modalNodeId} nodeId={modalNodeId} linkTargets={linkTargets} onClose={() => setModalNodeId(null)} onAttachImage={openImagePickerForNode} />
      )}

      {/* Full-screen image preview */}
      {preview && (
        <div className="preview-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) setPreview(null); }}>
          <img className="preview-img" src={preview.src} alt="" draggable={false} />
          <button className="preview-close" onClick={() => setPreview(null)} title="Close (Esc)">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>
      )}

      {/* Context menu */}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={ctxMenu.items}
          onClose={() => setCtxMenu(null)}
        />
      )}

      {/* In-app dialogs + toasts */}
      <DialogHost />
      <UpdateModal updater={updater} />
      <Toasts />
    </div>
  );
}

export default App;
