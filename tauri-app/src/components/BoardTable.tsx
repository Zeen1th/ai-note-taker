import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BoardNode as BoardNodeData, NodeKind } from '../lib/types';
import { tagChipStyle } from '../store/tagStore';

type ColKey = 'content' | 'kind' | 'tags' | 'color' | 'thumb' | 'words';

interface ColDef { key: ColKey; label: string; width: number }

const COL_DEFS: ColDef[] = [
  { key: 'content', label: 'Content', width: 300 },
  { key: 'kind', label: 'Kind', width: 110 },
  { key: 'tags', label: 'Tags', width: 200 },
  { key: 'color', label: 'Color', width: 70 },
  { key: 'thumb', label: 'Image', width: 92 },
  { key: 'words', label: 'Words', width: 80 },
];
const DEFAULT_COLS: ColKey[] = ['content', 'kind', 'tags', 'color'];
const TITLE_W = 250;
const HANDLE_W = 30;
const ACTIONS_W = 84;

interface BoardTableProps {
  boardId: string;
  nodes: BoardNodeData[];
  selectedId: string | null;
  imgSrc: (img: string) => string;
  rowTitle: (n: BoardNodeData) => string;
  rowSnippet: (n: BoardNodeData) => string;
  onOpen: (n: BoardNodeData) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onAddNote: (text?: string) => void;
  onAddRef: () => void;
}

const KIND_LABEL: Record<string, string> = { note: 'Note', reference: 'Reference', node: 'Container', group: 'Group' };
const SWATCH = ['var(--accent)', 'var(--sp1)', 'var(--sp2)', 'var(--sp3)', 'var(--sp4)', 'var(--sp5)'];

type SortKey = 'title' | 'kind' | 'tags';

const KIND_ICONS: Record<string, React.ReactNode> = {
  note: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" /><path d="M8 8h8M8 12h8M8 16h5" /></svg>,
  reference: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-5-5L5 21" /></svg>,
  node: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></svg>,
  group: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="4" y="4" width="16" height="16" rx="2" strokeDasharray="3 2" /><path d="M9 4v16M15 4v16M4 9h16M4 15h16" /></svg>,
};

export function BoardTable({ boardId, nodes, selectedId, imgSrc, rowTitle, rowSnippet, onOpen, onRename, onDelete, onAddNote, onAddRef }: BoardTableProps) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null);
  const [kindFilter, setKindFilter] = useState<'all' | NodeKind>('all');
  const [addDraft, setAddDraft] = useState('');
  // visible columns (ordered) + per-column widths + manual row order — persisted per board
  const [cols, setCols] = useState<ColKey[]>(DEFAULT_COLS);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [order, setOrder] = useState<string[] | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [colsOpen, setColsOpen] = useState(false);
  const colsRef = useRef<HTMLDivElement>(null);
  const tbodyRef = useRef<HTMLTableSectionElement>(null);

  // reset view-local state when the board changes
  useEffect(() => {
    setSort(null);
    setKindFilter('all');
    setAddDraft('');
    setColsOpen(false);
    try {
      const raw = localStorage.getItem('nt-table-' + boardId);
      if (raw) {
        const cfg = JSON.parse(raw);
        if (Array.isArray(cfg.cols)) setCols(cfg.cols.filter((c: string) => COL_DEFS.some((d) => d.key === c)));
        if (cfg.widths && typeof cfg.widths === 'object') setWidths(cfg.widths);
        if (Array.isArray(cfg.order)) setOrder(cfg.order);
      }
    } catch {}
  }, [boardId]);

  // persist table config (debounced)
  useEffect(() => {
    const t = setTimeout(() => {
      try { localStorage.setItem('nt-table-' + boardId, JSON.stringify({ cols, widths, order })); } catch {}
    }, 250);
    return () => clearTimeout(t);
  }, [cols, widths, order, boardId]);

  // close the columns popover on outside click
  useEffect(() => {
    if (!colsOpen) return;
    const onDown = (e: PointerEvent) => {
      if (colsRef.current && !colsRef.current.contains(e.target as Node)) setColsOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [colsOpen]);

  const colW = useCallback((key: string) =>
    widths[key] ?? (key === 'title' ? TITLE_W : COL_DEFS.find((d) => d.key === key)?.width ?? 150),
  [widths]);
  const toggleCol = (key: ColKey) => {
    setCols((prev) => (prev.includes(key) ? prev.filter((c) => c !== key) : [...prev, key]));
  };

  const rows = useMemo(() => {
    let r = kindFilter === 'all' ? nodes : nodes.filter((n) => n.kind === kindFilter);
    // manual row order applies unless a column sort is active (like Notion)
    if (order && !sort) {
      const byId = new Map(r.map((n) => [n.id, n]));
      const ord = order.filter((id) => byId.has(id));
      const rest = r.filter((n) => !ord.includes(n.id));
      r = [...ord.map((id) => byId.get(id)!), ...rest];
    }
    if (sort) {
      const { key, dir } = sort;
      r = [...r].sort((a, b) => {
        const av = key === 'title' ? rowTitle(a).toLowerCase() : key === 'kind' ? a.kind : (a.tags || []).length;
        const bv = key === 'title' ? rowTitle(b).toLowerCase() : key === 'kind' ? b.kind : (b.tags || []).length;
        const cmp = typeof av === 'number' ? av - (bv as number) : String(av).localeCompare(String(bv));
        return cmp * dir;
      });
    }
    return r;
  }, [nodes, kindFilter, sort, order, rowTitle]);

  const toggleSort = (key: SortKey) => {
    setSort((s) => {
      if (s && s.key === key) return s.dir === 1 ? { key, dir: -1 } : null;
      return { key, dir: 1 };
    });
  };
  const sortArrow = (key: SortKey) => (sort?.key === key ? (sort.dir === 1 ? ' ↑' : ' ↓') : '');

  // drag a row to reorder (manual order). Disabled while a column sort is active.
  const startRowDrag = (e: React.PointerEvent, id: string) => {
    if (sort) return;
    e.preventDefault();
    setDragId(id);
    document.body.classList.add('db-dragging');
    const move = (ev: PointerEvent) => {
      const els = Array.from(tbodyRef.current?.querySelectorAll('tr[data-id]') ?? []);
      const hit = els.find((el) => {
        const r = el.getBoundingClientRect();
        return ev.clientY >= r.top && ev.clientY <= r.bottom;
      });
      if (!hit) return;
      const targetId = hit.getAttribute('data-id');
      if (!targetId || targetId === id) return;
      const r = hit.getBoundingClientRect();
      const before = ev.clientY < r.top + r.height / 2;
      setOrder((prev) => {
        const cur = prev ? [...prev] : nodes.map((n) => n.id);
        const from = cur.indexOf(id);
        if (from === -1) return prev;
        cur.splice(from, 1);
        let to = cur.indexOf(targetId);
        if (to === -1) return prev;
        if (!before) to += 1;
        cur.splice(to, 0, id);
        const same = prev && prev.length === cur.length && prev.every((v, i) => v === cur[i]);
        return same ? prev : cur;
      });
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.body.classList.remove('db-dragging');
      setDragId(null);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  };

  // drag a column header divider to resize it
  const startResize = (e: React.PointerEvent, key: string) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = colW(key);
    document.body.classList.add('db-resizing');
    const move = (ev: PointerEvent) => {
      const w = Math.max(60, Math.min(640, startW + (ev.clientX - startX)));
      setWidths((prev) => ({ ...prev, [key]: w }));
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.body.classList.remove('db-resizing');
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  };

  const addRow = (
    <div className="db-add-row">
      <input
        className="db-add-input"
        placeholder="Type a note and press Enter to add…"
        value={addDraft}
        onChange={(e) => setAddDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && addDraft.trim()) {
            onAddNote(addDraft.trim());
            setAddDraft('');
          }
        }}
      />
      <button className="btn btn-ghost btn-sm" onClick={onAddRef} title="Add a whole image as a reference card">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-5-5L5 21" /></svg>
        Add reference
      </button>
    </div>
  );

  const headerCell = (key: ColKey, label: string, sortableKey?: SortKey) => (
    <th
      key={key}
      className={sortableKey ? 'sortable' : ''}
      style={{ width: colW(key) }}
      onClick={sortableKey ? () => toggleSort(sortableKey) : undefined}
      title={sortableKey ? 'Sort by ' + label.toLowerCase() : undefined}
    >
      {label}
      {sortableKey && sortArrow(sortableKey)}
      <span className="db-resizer" onPointerDown={(e) => startResize(e, key)} onClick={(e) => e.stopPropagation()} />
    </th>
  );

  return (
    <div className="db-wrap">
      <div className="db-head">
        <select className="input db-kind-select" value={kindFilter} onChange={(e) => setKindFilter(e.target.value as 'all' | NodeKind)} title="Filter by kind">
          <option value="all">All kinds</option>
          <option value="note">Notes</option>
          <option value="reference">References</option>
          <option value="node">Containers</option>
          <option value="group">Groups</option>
        </select>
        <div className="db-cols" ref={colsRef}>
          <button className="db-cols-btn" onClick={() => setColsOpen((o) => !o)} title="Show, hide and resize columns">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="9" cy="6" r="2" fill="var(--bg)" /><circle cx="15" cy="12" r="2" fill="var(--bg)" /><circle cx="7" cy="18" r="2" fill="var(--bg)" /></svg>
            Columns
          </button>
          {colsOpen && (
            <div className="db-cols-pop">
              <div className="db-cols-pop-title">Visible columns</div>
              {COL_DEFS.map((d) => (
                <label key={d.key} className="db-cols-item">
                  <input type="checkbox" checked={cols.includes(d.key)} onChange={() => toggleCol(d.key)} />
                  {d.label}
                </label>
              ))}
              <div className="db-cols-hint">Drag the column edges to resize · drag the ⣿ handle to reorder rows</div>
            </div>
          )}
        </div>
        <span className="ws-count">{rows.length} {rows.length === 1 ? 'item' : 'items'}</span>
        {sort && <span className="ws-count db-sort-hint">sorted — click a header again to clear</span>}
      </div>
      <div className="db-scroll">
        {nodes.length === 0 ? (
          <div className="ws-empty">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M3 9V5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></svg>
            <p>This board has no cards</p>
            <span className="hint">Add notes here, or place them on the board view</span>
            <div className="ws-empty-actions">
              <button className="btn btn-primary btn-sm" onClick={() => onAddNote('')}>Add a note</button>
              <button className="btn btn-ghost btn-sm" onClick={onAddRef}>Add a reference</button>
            </div>
          </div>
        ) : rows.length === 0 ? (
          <div className="ws-empty"><p>No cards match this filter</p></div>
        ) : (
          <table className="db-table">
            <thead>
              <tr>
                <th className="db-th-handle" style={{ width: HANDLE_W }} />
                <th className="db-th-title sortable" style={{ width: TITLE_W }} onClick={() => toggleSort('title')} title="Sort by title">
                  Title{sortArrow('title')}
                  <span className="db-resizer" onPointerDown={(e) => startResize(e, 'title')} onClick={(e) => e.stopPropagation()} />
                </th>
                {headerCell('content', 'Content')}
                {cols.includes('kind') && headerCell('kind', 'Kind', 'kind')}
                {cols.includes('tags') && headerCell('tags', 'Tags', 'tags')}
                {cols.includes('color') && headerCell('color', 'Color')}
                {cols.includes('thumb') && headerCell('thumb', 'Image')}
                {cols.includes('words') && headerCell('words', 'Words')}
                <th className="db-th-actions" style={{ width: ACTIONS_W }} />
              </tr>
            </thead>
            <tbody ref={tbodyRef}>
              {rows.map((n) => (
                <tr key={n.id} data-id={n.id} className={`db-row${selectedId === n.id ? ' selected' : ''}${dragId === n.id ? ' dragging' : ''}`} onClick={() => onOpen(n)} title="Click to open">
                  <td className="db-cell-handle">
                    {!sort && (
                      <button className="db-drag" title="Drag to reorder" onPointerDown={(e) => startRowDrag(e, n.id)} onClick={(e) => e.stopPropagation()}>
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="5" r="1.6" /><circle cx="15" cy="5" r="1.6" /><circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" /><circle cx="9" cy="19" r="1.6" /><circle cx="15" cy="19" r="1.6" /></svg>
                      </button>
                    )}
                  </td>
                  <td className="db-cell-title">
                    <span className={`db-kind-icon kind-${n.kind}`}>{KIND_ICONS[n.kind] || KIND_ICONS.note}</span>
                    <input
                      className="db-title-input"
                      key={n.id + rowTitle(n)}
                      defaultValue={rowTitle(n)}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        if (v !== (n.customTitle || '').trim()) onRename(n.id, v);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.currentTarget.blur();
                        if (e.key === 'Escape') { e.currentTarget.value = rowTitle(n); e.currentTarget.blur(); }
                      }}
                    />
                  </td>
                  {cols.includes('content') && (
                    <td className="db-cell-content"><span className="db-snippet">{rowSnippet(n)}</span></td>
                  )}
                  {cols.includes('kind') && (
                    <td><span className={`lib-kind-chip kind-${n.kind}`}>{KIND_LABEL[n.kind] || n.kind}</span></td>
                  )}
                  {cols.includes('tags') && (
                    <td className="db-cell-tags">
                      {(n.tags || []).map((t) => (
                        <span key={t} className="tag-chip c-tag" style={tagChipStyle({ name: t })}>{t}</span>
                      ))}
                    </td>
                  )}
                  {cols.includes('color') && (
                    <td><span className="db-swatch" style={{ background: SWATCH[Math.max(0, Math.min(n.c, 5))] }} title={`Color ${n.c}`} /></td>
                  )}
                  {cols.includes('thumb') && (
                    <td>{n.image ? <img className="db-thumb" src={imgSrc(n.image)} draggable={false} alt="" /> : <span className="db-empty-cell">—</span>}</td>
                  )}
                  {cols.includes('words') && (
                    <td className="db-cell-words">{(n.text || '').split(/\s+/).filter(Boolean).length}</td>
                  )}
                  <td className="db-cell-actions" onClick={(e) => e.stopPropagation()}>
                    {n.kind !== 'group' && (
                      <button className="db-row-btn" title={n.kind === 'reference' ? 'Preview image' : 'Open'} onClick={() => onOpen(n)}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" /></svg>
                      </button>
                    )}
                    <button className="db-row-btn del" title="Delete" onClick={() => onDelete(n.id)}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 6l12 12M18 6 6 18" /></svg>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {nodes.length > 0 && addRow}
    </div>
  );
}
