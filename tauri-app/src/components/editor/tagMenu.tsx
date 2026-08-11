// #-tag menu: typing `#word` in an editor shows a popup to pick an existing
// tag or create a new one. Shared by the focus-mode editor and board nodes.
import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import type { Editor } from '@tiptap/react';
import { useTagStore, tagColor, TAG_COLORS } from '../../store/tagStore';

export interface TagMenuState { x: number; y: number; query: string; }

export function useTagMenu(editor: Editor | null, onSelect: (tag: string) => void) {
  const [menu, setMenu] = useState<TagMenuState | null>(null);
  const [idx, setIdx] = useState(0);
  const known = useTagStore((s) => s.tags);
  const apiRef = useRef<{ open: boolean; items: string[]; idx: number; pick: (i: number) => void; close: () => void } | null>(null);

  useEffect(() => {
    const s = useTagStore.getState();
    if (!s.loaded) s.refresh();
  }, []);

  const close = useCallback(() => { setMenu(null); setIdx(0); }, []);

  const query = menu?.query ?? '';
  const suggestions = useMemo(
    () => known.filter((t) => t.name.includes(query.toLowerCase())).map((t) => t.name),
    [known, query],
  );
  const items = useMemo<string[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return suggestions;
    return suggestions.includes(q) ? suggestions : [q, ...suggestions];
  }, [query, suggestions]);

  const pick = useCallback((tag: string) => {
    if (!editor) return;
    const { selection } = editor.state;
    const { from } = selection;
    const doc = editor.state.doc;
    let start = from - 1;
    while (start > 0 && /[A-Za-z0-9-_]/.test(doc.textBetween(start - 1, start))) start--;
    if (doc.textBetween(start, start + 1) === '#') {
      editor.chain().focus().deleteRange({ from: start, to: from }).run();
    }
    onSelect(tag);
    close();
  }, [editor, onSelect, close]);

  // keep the API fresh for the capture-phase keydown listener.
  // Only act on keys while the menu is actually open — with no menu the
  // suggestions list is "all tags", so Enter must never trigger a pick.
  useEffect(() => {
    apiRef.current = {
      open: menu !== null,
      items,
      idx,
      pick: (i) => { const it = items[i]; if (it) pick(it); },
      close,
    };
  }, [menu, items, idx, pick, close]);

  useEffect(() => {
    if (!editor) return;

    const onKeyDown = (e: KeyboardEvent) => {
      const api = apiRef.current;
      if (!api || !api.open || api.items.length === 0) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); setIdx((i) => (i + 1) % api.items.length); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); setIdx((i) => (i - 1 + api.items.length) % api.items.length); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); api.pick(api.idx); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); api.close(); }
    };
    document.addEventListener('keydown', onKeyDown, true);

    const check = () => {
      if (!editor) return;
      const { selection } = editor.state;
      const { from } = selection;
      if (!selection.empty) { close(); return; }
      const doc = editor.state.doc;
      let start = from - 1;
      while (start > 0 && from - start < 40 && /[A-Za-z0-9-_]/.test(doc.textBetween(start - 1, start))) start--;
      const isTag = doc.textBetween(start, start + 1) === '#';
      if (!isTag) { close(); return; }
      const coords = editor.view.coordsAtPos(from);
      setMenu({ x: Math.max(8, coords.left), y: coords.bottom + 4, query: doc.textBetween(start + 1, from) });
      setIdx(0);
    };
    editor.on('transaction', check);
    editor.on('blur', close);

    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      editor.off('transaction', check);
      editor.off('blur', close);
    };
  }, [editor, close]);

  return { tagMenu: menu, tagItems: items, tagIdx: idx, pickTag: pick, closeTag: close, setTagIdx: setIdx };
}

export function TagMenuView({ menu, items, idx, onPick, onHover }: {
  menu: TagMenuState;
  items: string[];
  idx: number;
  onPick: (tag: string) => void;
  onHover: (i: number) => void;
}) {
  const isNew = (t: string) => menu.query.trim() && t === menu.query.trim();
  return createPortal(
    <div className="tag-menu" style={{ left: menu.x, top: menu.y }}>
      {items.length === 0 && <div className="slash-empty">No tags yet — keep typing</div>}
      {items.map((t, i) => (
        <div
          key={t}
          className={`slash-item ${i === idx % Math.max(1, items.length) ? 'active' : ''}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(t)}
          onMouseEnter={() => onHover(i)}
        >
          <span className="tag-dot" style={{ background: TAG_COLORS[tagColor({ name: t }) - 1] }} />
          <span className="slash-label">{t}</span>
          {isNew(t) && <span className="slash-hint" style={{ marginLeft: 'auto' }}>new tag</span>}
        </div>
      ))}
      {items.length > 0 && (
        <div className="tag-menu-foot"><span className="slash-hint"># adds a tag to this note</span></div>
      )}
    </div>,
    document.body
  );
}
