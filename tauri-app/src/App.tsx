import { useState, useEffect, useRef, useCallback } from 'react';
import './styles/theme.css';
import './styles/app.css';
import { listBoards, createBoard, deleteBoard, renameBoard, minimizeWindow, toggleMaximize, closeWindow, saveBoardImage } from './lib/tauri';
import { useBoardStore } from './store/boardStore';
import { BoardNode } from './components/BoardNode';
import { BoardEdge } from './components/BoardEdge';
import { NoteModal } from './components/NoteModal';
import { ContextMenu, type CtxItem } from './components/ContextMenu';
import { Capture } from './components/Capture';
import { Settings } from './components/Settings';
import { DialogHost, showPrompt, showConfirm } from './lib/dialogs';
import { Toasts, toast } from './lib/toast';
import type { Board, Tool } from './lib/types';

const PALETTES = ['notebook', 'blueprint', 'aurora'] as const;

function App() {
  const [boards, setBoards] = useState<Board[]>([]);
  const [palette, setPalette] = useState<string>(() => localStorage.getItem('nt-palette') || 'notebook');
  const [theme, setTheme] = useState<string>(() => localStorage.getItem('nt-theme') || 'light');

  const {
    nodes, edges, view, currentBoardId,
    loadBoard, addNode, updateNode, deleteNode, deleteEdge, addEdge, duplicateNode, setView, selectNode, clearSelection, scheduleSave,
  } = useBoardStore();

  const viewportRef = useRef<HTMLDivElement>(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const [modalNodeId, setModalNodeId] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; items: CtxItem[] } | null>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [provisional, setProvisional] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [selRect, setSelRect] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [screen, setScreen] = useState<'board' | 'capture' | 'settings'>('board');
  const imageInputRef = useRef<HTMLInputElement>(null);
  const imageDropPtRef = useRef<{ x: number; y: number } | null>(null);

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
  }, []);

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
    const newZoom = Math.max(0.3, Math.min(2.5, view.zoom * factor));
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
    const zoom = Math.max(0.3, scale);
    setView({ zoom, x: (rect.width - (maxX - minX) * zoom) / 2 - minX * zoom, y: (rect.height - (maxY - minY) * zoom) / 2 - minY * zoom });
  }, [nodes, setView]);

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
      else if (tool === 'note') { addNode(wpt0.x, wpt0.y, ''); }
      else if (tool === 'image') { openImagePicker(wpt0); }
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }, [view, spaceDown, clearSelection, setView, scheduleSave, tool, addNode, openImagePicker, screenToWorld]);

  const onViewportDoubleClick = useCallback((e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('.board-node')) return;
    const wpt = screenToWorld(e.clientX, e.clientY);
    addNode(wpt.x, wpt.y, '');
  }, [screenToWorld, addNode]);

  const onWheel = useCallback((e: React.WheelEvent) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    zoomAt(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - rect.left, e.clientY - rect.top);
  }, [zoomAt]);

  // right-click context menu
  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const nodeEl = (e.target as HTMLElement).closest('.board-node');
    const wpt = screenToWorld(e.clientX, e.clientY);
    if (nodeEl) {
      const nid = nodeEl.getAttribute('data-id') || '';
      selectNode(nid);
      setCtxMenu({
        x: e.clientX, y: e.clientY,
        items: [
          { label: 'Open in focus mode', action: () => setModalNodeId(nid) },
          { label: 'Connect from here…', action: () => { selectNode(nid); setToolActive('connect'); toast('Click another note to connect.'); } },
          { label: 'Duplicate', action: () => duplicateNode(nid) },
          { sep: true },
          { label: 'Delete', danger: true, action: () => deleteNode(nid) },
        ],
      });
    } else {
      setCtxMenu({
        x: e.clientX, y: e.clientY,
        items: [
          { label: 'Add note here', action: () => addNode(wpt.x, wpt.y, '') },
          { label: 'Add image here', action: () => openImagePicker(wpt) },
          { label: 'Connect nodes', action: () => { setToolActive('connect'); toast('Drag from one note to another to connect.'); } },
          { sep: true },
          { label: 'Arrange all', action: arrangeNodes },
          { label: 'Fit view', action: fitToView },
          { sep: true },
          { label: 'New board…', action: handleCreateBoard },
        ],
      });
    }
  }, [screenToWorld, selectNode, nodes, updateNode, deleteNode, addNode, duplicateNode, openImagePicker]);

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
        setToolActive('select');
      }
    };
    document.addEventListener('keydown', onEsc);
    return () => document.removeEventListener('keydown', onEsc);
  }, []);

  // tool keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName) || (e.target as HTMLElement).isContentEditable) return;
      const map: Record<string, Tool> = { v: 'select', n: 'note', i: 'image', c: 'connect' };
      const t = map[e.key.toLowerCase()];
      if (t) setToolActive(t);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

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
  function openBoard(boardId: string) { setScreen('board'); loadBoard(boardId); }

  function setToolActive(t: Tool) {
    setTool(t);
    document.body.className = 'tool-' + t;
    if (t !== 'connect') setProvisional(null);
  }

  // Drag-from-a-node to connect (like the old app): pointerdown on a node in
  // connect mode draws a provisional edge; release over another node to link.
  const startConnect = useCallback((nodeId: string, e: React.PointerEvent) => {
    e.preventDefault();
    const from = nodes.find((n) => n.id === nodeId);
    if (!from) return;
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
  function openImagePicker(wpt: { x: number; y: number }) {
    imageDropPtRef.current = wpt;
    imageInputRef.current?.click();
  }

  const onImagePicked = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    const ext = '.' + ((f.name.split('.').pop() || '').toLowerCase());
    if (!['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) {
      toast('Unsupported image type.');
      return;
    }
    const buf = new Uint8Array(await f.arrayBuffer());
    if (buf.length > 8 * 1024 * 1024) { toast('Image too large (max 8 MB).'); return; }
    try {
      const { url } = await saveBoardImage(buf, ext);
      const pt = imageDropPtRef.current || { x: 60, y: 60 };
      const node = addNode(pt.x, pt.y, '');
      updateNode(node.id, { kind: 'image', image: url, w: 320, h: 220 });
      imageDropPtRef.current = null;
      toast('Image added.');
    } catch (err: any) {
      toast(String(err.message || err));
    }
  }, [addNode, updateNode]);

  const nodeCount = nodes.length;
  const currentBoard = boards.find((b) => b.id === currentBoardId);
  let svgW = 2000, svgH = 2000;
  nodes.forEach((n) => { svgW = Math.max(svgW, n.x + n.w + 400); svgH = Math.max(svgH, n.y + n.h + 400); });

  return (
    <div className="app">
      <div className="titlebar" data-tauri-drag-region>
        <div className="titlebar-left"><span className="brand-mark" /><span className="brand-name">note·taker</span></div>
        <span className="tb-crumb">
          {screen === 'capture' ? 'Tools / ' : screen === 'settings' ? 'Tools / ' : 'Board / '}
          <b>{screen === 'board' ? currentBoard?.name || '' : screen === 'capture' ? 'Capture' : 'Settings'}</b>
        </span>
        <div className="titlebar-spacer" />
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
            <span className={`nav-item ${screen === 'capture' ? 'active' : ''}`} onClick={() => setScreen('capture')} style={{ cursor: 'pointer' }}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3Z" /><path d="M19 10v1a7 7 0 0 1-14 0v-1" /></svg> Capture</span>
            <span className={`nav-item ${screen === 'settings' ? 'active' : ''}`} onClick={() => setScreen('settings')} style={{ cursor: 'pointer' }}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" /></svg> Settings</span>
          </div>
          <div className="sidebar-foot"><span className="foot-meta">local · private<br />v3.0 · tauri build</span></div>
        </nav>

        <main className="main">
          {screen === 'capture' ? (
            <Capture onOpenBoard={openBoard} />
          ) : screen === 'settings' ? (
            <div className="scroll" style={{ flex: 1, overflowY: 'auto' }}>
              <Settings palette={palette} theme={theme} onPalette={setPalette} onTheme={setTheme} />
            </div>
          ) : (
          <>
          <div className="board-toolbar">
            <div className="tool-bar">
              <button className={`tool ${tool === 'select' ? 'active' : ''}`} title="Select / pan (V)" onClick={() => setToolActive('select')}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m3 3 7.5 18 2.7-7.8L21 10.5z" /></svg></button>
              <button className={`tool ${tool === 'note' ? 'active' : ''}`} title="Add note (N)" onClick={() => setToolActive('note')}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 5v14M5 12h14" /></svg></button>
              <button className={`tool ${tool === 'image' ? 'active' : ''}`} title="Add image (I)" onClick={() => setToolActive('image')}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-5-5L5 21" /></svg></button>
              <span className="tool-sep" />
              <button className={`tool ${tool === 'connect' ? 'active' : ''}`} title="Connect notes (C)" onClick={() => setToolActive('connect')}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="5" cy="12" r="2" /><circle cx="19" cy="12" r="2" /><path d="M7 12h10" /></svg></button>
            </div>
            <button className="btn btn-ghost btn-sm" onClick={arrangeNodes} title="Arrange nodes in a grid">Arrange</button>
            <button className="btn btn-ghost btn-sm" onClick={fitToView} title="Fit all nodes">Fit</button>
            <div className="grow" />
            <span className="board-count">{nodeCount} {nodeCount === 1 ? 'note' : 'notes'}</span>
          </div>

          <div className="board-viewport" ref={viewportRef} onPointerDown={onViewportPointerDown} onDoubleClick={onViewportDoubleClick as any} onWheel={onWheel} onContextMenu={onContextMenu}>
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
              {nodes.map((node) => (<BoardNode key={node.id} node={node} zoom={view.zoom} onConnectStart={startConnect} />))}
              {selRect && (
                <div className="selection-rect" style={{
                  left: Math.min(selRect.x1, selRect.x2),
                  top: Math.min(selRect.y1, selRect.y2),
                  width: Math.abs(selRect.x2 - selRect.x1),
                  height: Math.abs(selRect.y2 - selRect.y1),
                }} />
              )}
              {nodes.length === 0 && (<div className="board-empty"><p>Double-click anywhere to add a note</p></div>)}
            </div>
            <div className="zoom-ctl">
              <button className="zoom-btn" onClick={() => zoomAt(1.2)}>+</button>
              <span className="zoom-label">{Math.round(view.zoom * 100)}%</span>
              <button className="zoom-btn" onClick={() => zoomAt(1 / 1.2)}>−</button>
              <button className="zoom-btn" onClick={fitToView} style={{ fontSize: '0.7rem' }}>⤢</button>
            </div>
          </div>
          </>
          )}
        </main>
      </div>

      {/* Hidden file picker for board images */}
      <input
        ref={imageInputRef}
        type="file"
        accept=".png,.jpg,.jpeg,.gif,.webp"
        hidden
        onChange={onImagePicked}
      />

      {/* Modal note editor */}
      {modalNodeId && (
        <NoteModal key={modalNodeId} nodeId={modalNodeId} onClose={() => setModalNodeId(null)} />
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
      <Toasts />
    </div>
  );
}

export default App;
