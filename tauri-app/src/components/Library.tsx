import { useEffect, useMemo, useState, useCallback } from 'react';
import { listBoards, getBoard, getSidecarUrl, putBoard } from '../lib/tauri';
import { renderMarkdown } from '../lib/markdown';
import { docToMarkdown, htmlToText } from '../lib/editor/markdown';
import { getAiCfg } from '../lib/ai';
import { showPrompt, showConfirm } from '../lib/dialogs';
import { useTagStore, tagColor, TAG_COLORS, tagChipStyle } from '../store/tagStore';
import type { Board, BoardNode, BoardEdge } from '../lib/types';

interface BoardWithNodes {
  board: Board;
  nodes: BoardNode[];
  edges: BoardEdge[];
}

const NOTE_COLORS = ['var(--accent)', 'var(--sp1)', 'var(--sp2)', 'var(--sp3)', 'var(--sp4)', 'var(--sp5)'];

// Prefer the rich TipTap document (blocks) → markdown; fall back to plain text.
function noteMarkdown(n: BoardNode): string {
  if (n.blocks) {
    try {
      const parsed = JSON.parse(n.blocks);
      if (parsed && Array.isArray(parsed.content)) return docToMarkdown(parsed);
    } catch {}
  }
  return htmlToText(n.text || '');
}

const stripMarks = (s: string) =>
  s
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-+*]\s+/, '')
    .replace(/\*\*|__|~~|\*|_|`/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim();

function noteTitle(n: BoardNode) {
  if ((n.customTitle || '').trim()) return (n.customTitle || '').trim();
  if (n.kind === 'reference') return 'Reference';
  if (n.kind === 'node') return 'Untitled node';
  const first = noteMarkdown(n).split('\n').find((l) => l.trim());
  const plain = stripMarks(first || '');
  return plain.slice(0, 60) || 'Untitled note';
}

function noteSnippet(n: BoardNode) {
  if (n.kind === 'reference') return 'Whole image card';
  if (n.kind === 'node') return 'Container — holds notes & references';
  const lines = noteMarkdown(n).split('\n').filter((l) => l.trim());
  const rest = lines.length > 1 ? lines.slice(1).join(' ') : (lines[0] || '');
  return stripMarks(rest).slice(0, 140);
}

function kindLabel(n: BoardNode) {
  return n.kind === 'reference' ? 'Reference' : n.kind === 'node' ? 'Node' : 'Note';
}

function wordCount(n: BoardNode) {
  const t = noteMarkdown(n).trim();
  return t ? t.split(/\s+/).length : 0;
}

function fmtDate(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days < 1) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined });
}

type Tab = 'boards' | 'notes' | 'ai' | 'tags';

const COLOR_CYCLE = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 0];

const normalizeTag = (s: string) =>
  s.trim().replace(/^#+/, '').replace(/\s+/g, '-').replace(/[^A-Za-z0-9_-]/g, '').toLowerCase();

export function Library({
  onOpenBoard,
  onOpenFocus,
}: {
  onOpenBoard: (boardId: string, nodeId?: string) => void;
  onOpenFocus: (boardId: string, nodeId: string) => void;
}) {
  const [data, setData] = useState<BoardWithNodes[] | null>(null);
  const [tab, setTab] = useState<Tab>('boards');
  const [q, setQ] = useState('');
  const [tagSel, setTagSel] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiReply, setAiReply] = useState('');
  const tagStore = useTagStore();
  const known = tagStore.tags;

  const loadAll = useCallback(async () => {
    const list = await listBoards();
    const withNodes = await Promise.all(
      list.map(async (b) => {
        const g = await getBoard(b.id);
        return { board: b, nodes: g.nodes, edges: g.edges };
      }),
    );
    setData(withNodes);
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await loadAll();
      } catch {
        if (alive) setData([]);
      }
    })();
    return () => { alive = false; };
  }, [loadAll]);

  // rename or delete a tag across every board (tags are strings on nodes)
  const mutateTag = useCallback(async (oldName: string, newName: string | null) => {
    if (!data) return;
    const rename = newName !== null && newName !== oldName;
    const edits = data.filter(({ nodes }) =>
      nodes.some((n) => (n.tags || []).includes(oldName)),
    );
    for (const { board, nodes, edges } of edits) {
      await putBoard(
        board.id,
        nodes.map((n) => ({
          ...n,
          tags: (n.tags || [])
            .filter((t) => t !== oldName)
            .concat(rename ? [newName as string] : []),
        })),
        edges,
      );
    }
  }, [data]);

  const refreshAll = useCallback(async () => {
    await Promise.all([tagStore.refresh(), loadAll()]);
  }, [tagStore, loadAll]);

  const createTag = useCallback(async () => {
    const raw = await showPrompt({ title: 'New tag', placeholder: 'Tag name (letters, numbers, dashes)' });
    if (!raw) return;
    const name = normalizeTag(raw);
    if (!name) return;
    const exists = tagStore.tags.find((t) => t.name === name);
    if (exists) { setTab('notes'); setTagSel(name); return; }
    await tagStore.setColor(name, tagColor({ name }));
    await refreshAll();
  }, [tagStore, refreshAll]);

  const renameTag = useCallback(async (oldName: string) => {
    const next = await showPrompt({ title: 'Rename tag', initial: oldName, placeholder: 'New name' });
    if (!next) return;
    const newName = normalizeTag(next);
    if (!newName || newName === oldName) return;
    const oldInfo = tagStore.tags.find((t) => t.name === oldName);
    const hasOldColor = !!oldInfo && oldInfo.color >= 1 && oldInfo.color <= TAG_COLORS.length;
    const newHasColor = tagStore.tags.some((t) => t.name === newName && t.color >= 1);
    await mutateTag(oldName, newName);
    if (hasOldColor && !newHasColor) await tagStore.setColor(newName, oldInfo.color);
    if (hasOldColor) await tagStore.resetColor(oldName);
    await refreshAll();
  }, [tagStore, mutateTag, refreshAll]);

  const deleteTag = useCallback(async (name: string) => {
    if (!(await showConfirm('Remove tag', `Remove #${name} from all notes?`))) return;
    await mutateTag(name, null);
    await tagStore.resetColor(name);
    await refreshAll();
  }, [tagStore, mutateTag, refreshAll]);

  const cycleColor = useCallback(async (name: string, color: number) => {
    const next = COLOR_CYCLE[(COLOR_CYCLE.indexOf(color) + 1) % COLOR_CYCLE.length];
    if (next === 0) await tagStore.resetColor(name);
    else await tagStore.setColor(name, next);
  }, [tagStore]);

  const all = data || [];

  const corpus = useMemo(
    () => all
      .map(({ board, nodes }) =>
        nodes.map((n) => `[Board: ${board.name}] ${noteTitle(n)}\n${noteMarkdown(n)}`).join('\n\n'),
      )
      .join('\n\n\n'),
    [all],
  );

  const runAiSearch = useCallback(async (text: string) => {
    const query = text.trim();
    if (!query || aiBusy) return;
    setAiBusy(true);
    setAiReply('');
    try {
      const baseUrl = await getSidecarUrl();
      const res = await fetch(`${baseUrl}/api/library/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, corpus, cfg: getAiCfg() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || `Failed (${res.status})`);
      setAiReply(data.reply || '');
    } catch (err: any) {
      setAiReply('⚠ ' + err.message);
    } finally {
      setAiBusy(false);
    }
  }, [aiBusy, corpus]);

  const query = q.trim().toLowerCase();
  const tagQuery = query.replace(/^#+/, '');

  const boardsFiltered = useMemo(() => {
    if (!query) return all;
    return all.filter(
      ({ board, nodes }) =>
        board.name.toLowerCase().includes(query) ||
        nodes.some(
          (n) =>
            (n.customTitle || '').toLowerCase().includes(query) ||
            (n.text || '').toLowerCase().includes(query) ||
            (n.tags || []).join(' ').toLowerCase().includes(tagQuery),
        ),
    );
  }, [all, query, tagQuery]);

  const notesFiltered = useMemo(() => {
    const rows = all.flatMap(({ board, nodes }) => nodes.map((n) => ({ board, note: n })));
    let out = rows;
    if (query) {
      out = out.filter(
        ({ board, note }) =>
          (note.customTitle || '').toLowerCase().includes(query) ||
          (note.text || '').toLowerCase().includes(query) ||
          board.name.toLowerCase().includes(query) ||
          (note.tags || []).join(' ').toLowerCase().includes(tagQuery),
      );
    }
    if (tagSel) out = out.filter(({ note }) => (note.tags || []).includes(tagSel));
    return out;
  }, [all, query, tagQuery, tagSel]);

  return (
    <div className="scroll lib" style={{ flex: 1, overflowY: 'auto' }}>
      <div className="lib-head">
        <span className="lib-eyebrow">Browse</span>
        <h1>Library</h1>
        <p>Every board and note in one place — search locally, or ask AI to find what relates.</p>
      </div>

      <div className="lib-tabs" role="tablist" aria-label="Library views">
        {(['boards', 'notes', 'ai', 'tags'] as Tab[]).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={`lib-tab ${tab === t ? 'active' : ''}`}
            onClick={() => setTab(t)}
          >
            {t === 'boards' && <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>}
            {t === 'notes' && <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" /><path d="M8 8h8M8 12h8M8 16h5" /></svg>}
            {t === 'ai' && <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" /><circle cx="12" cy="12" r="4" /></svg>}
            {t === 'tags' && <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M20.59 13.41 12 22l-8-8V4h10l6.59 6.59a2 2 0 0 1 0 2.82Z" /><circle cx="7.5" cy="7.5" r="1.5" /></svg>}
            {t}
          </button>
        ))}
      </div>

      <div className="lib-search">
        <svg className="lib-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.35-4.35" /></svg>
        <input
          className="input"
          placeholder={tab === 'ai' ? 'Describe what you are looking for…' : 'Search notes & boards…'}
          value={q}
          onChange={(e) => { setQ(e.target.value); setAiReply(''); }}
          onKeyDown={(e) => { if (e.key === 'Enter' && tab === 'ai') runAiSearch(q); }}
        />
        {q && (
          <button className="lib-clear" onClick={() => setQ('')} aria-label="Clear search">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        )}
      </div>

      {!data ? (
        <div className="lib-empty">Loading…</div>
      ) : tab === 'boards' ? (
        <div className="lib-boards">
          {boardsFiltered.length === 0 ? (
            <div className="lib-empty">
              <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>
              <p>{query ? `No boards match “${q}”.` : 'No boards yet — create one from the sidebar.'}</p>
            </div>
          ) : (
            boardsFiltered.map(({ board, nodes }) => (
              <button
                key={board.id}
                className="lib-board-card"
                onClick={() => onOpenBoard(board.id)}
              >
                <span className="lib-board-strip" />
                <span className="lib-board-body">
                  <span className="lib-board-name">{board.name}</span>
                  <span className="lib-board-meta">
                    {nodes.length} {nodes.length === 1 ? 'note' : 'notes'} · {nodes.reduce((s, n) => s + wordCount(n), 0)} words
                    {board.updatedAt ? ` · ${fmtDate(board.updatedAt)}` : ''}
                  </span>
                  {[...new Set(nodes.flatMap((n) => n.tags || []))].slice(0, 3).length > 0 && (
                    <span className="lib-board-tags">
                      {[...new Set(nodes.flatMap((n) => n.tags || []))].slice(0, 3).map((t) => (
                        <span key={t} className="tag-chip c-tag" style={tagChipStyle({ name: t })}>{t}</span>
                      ))}
                    </span>
                  )}
                  {nodes.slice(0, 2).map((n) => (
                    <span key={n.id} className="lib-board-preview">
                      <span className="lib-preview-title">{noteTitle(n)}</span>
                      <span className="lib-preview-text">{noteSnippet(n) || 'Empty note'}</span>
                    </span>
                  ))}
                  <span className="lib-open">Open board <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M13 6l6 6-6 6" /></svg></span>
                </span>
              </button>
            ))
          )}
        </div>
      ) : tab === 'notes' ? (
        <div className="lib-notes">
          {known.length > 0 && (
            <div className="lib-tagbar">
              <button className={`tag-chip ${tagSel === null ? 'active' : ''}`} onClick={() => setTagSel(null)}>All</button>
              {known.map((t) => (
                <button key={t.name} className={`tag-chip c-tag ${tagSel === t.name ? 'active' : ''}`} style={tagChipStyle({ name: t.name })} onClick={() => setTagSel(tagSel === t.name ? null : t.name)}>
                  {t.name}
                </button>
              ))}
            </div>
          )}
          {notesFiltered.length === 0 ? (
            <div className="lib-empty">
              <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" /><path d="M8 8h8M8 12h8M8 16h5" /></svg>
              <p>{query ? `No notes match “${q}”.` : tagSel ? `No notes tagged #${tagSel}.` : 'No notes yet — double-click a board to add one.'}</p>
            </div>
          ) : (
            notesFiltered.map(({ board, note }) => (
              <button key={note.id} className="lib-note-row" onClick={() => (note.kind === 'note' ? onOpenFocus(board.id, note.id) : onOpenBoard(board.id, note.id))}>
                <span className="lib-note-dot" style={{ background: NOTE_COLORS[note.c % NOTE_COLORS.length] }} />
                <span className={`lib-kind-chip kind-${note.kind}`}>{kindLabel(note)}</span>
                <span className="lib-note-content">
                  <span className="lib-note-title">{noteTitle(note)}</span>
                  <span className="lib-note-snippet">{noteSnippet(note) || 'Empty note'}</span>
                  {(note.tags || []).length > 0 && (
                    <span className="lib-note-tags">
                      {(note.tags || []).map((t) => (
                        <span key={t} className="tag-chip c-tag" style={tagChipStyle({ name: t })} onClick={(e) => { e.stopPropagation(); setTagSel(tagSel === t ? null : t); }}>
                          {t}
                        </span>
                      ))}
                    </span>
                  )}
                </span>
                <span className="lib-badge">{board.name}</span>
              </button>
            ))
          )}
        </div>
      ) : tab === 'tags' ? (
        <div className="lib-tags">
          <div className="lib-tag-head">
            <span className="lib-ai-title">Tags manager</span>
            <span className="hint">{known.length} {known.length === 1 ? 'tag' : 'tags'}</span>
            <span className="grow" />
            <button className="btn btn-primary btn-sm" onClick={createTag}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14" /></svg>
              New tag
            </button>
          </div>
          {(() => {
            const filtered = known.filter((t) => t.name.includes(tagQuery));
            return filtered.length === 0 ? (
              <div className="lib-empty">
                <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M20.59 13.41 12 22l-8-8V4h10l6.59 6.59a2 2 0 0 1 0 2.82Z" /><circle cx="7.5" cy="7.5" r="1.5" /></svg>
                <p>{query ? `No tags match “${q}”.` : 'No tags yet — type # in a note and the tag shows up here.'}</p>
              </div>
            ) : (
              filtered.map((t) => (
                <div key={t.name} className="lib-tag-row">
                  <button className="lib-tag-swatch" style={{ background: TAG_COLORS[tagColor(t) - 1] }} onClick={() => cycleColor(t.name, tagColor(t))} title="Click to change color">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m20 6-11 11-5-5" /></svg>
                  </button>
                  <button className="lib-tag-name" onClick={() => { setTab('notes'); setTagSel(t.name); }}>{t.name}</button>
                  <span className="lib-tag-count">{t.count} {t.count === 1 ? 'note' : 'notes'}</span>
                  <span className="grow" />
                  <button className="btn btn-ghost btn-sm" onClick={() => renameTag(t.name)} title="Rename">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
                    Rename
                  </button>
                  <button className="btn btn-ghost btn-sm danger" onClick={() => deleteTag(t.name)} title="Delete tag from all notes">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></svg>
                  </button>
                </div>
              ))
            );
          })()}
        </div>
      ) : (
        <div className="lib-ai">
          <div className="lib-ai-bar">
            <span className="lib-ai-title">AI search</span>
            <span className="hint">reads every note on this device</span>
            <span className="grow" />
            <button
              className="btn btn-primary"
              disabled={!query || aiBusy}
              onClick={() => runAiSearch(q)}
            >
              {aiBusy ? 'Thinking…' : 'Search with AI'}
            </button>
          </div>
          {aiReply ? (
            <div className="lib-ai-reply" dangerouslySetInnerHTML={{ __html: renderMarkdown(aiReply) }} />
          ) : aiBusy ? (
            <div className="lib-ai-reply lib-ai-thinking"><span className="pulse" />The AI is reading your notes…</div>
          ) : (
            <div className="lib-ai-placeholder">
              <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" /><circle cx="12" cy="12" r="4" /></svg>
              <p>Ask in plain language — “which notes mention the budget?” — and get the matching boards and notes.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
