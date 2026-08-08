// Slash-command palette: a hook that drives the floating menu from editor
// transactions + key events, and the menu view itself. Reusable by both the
// focus-mode editor and the inline board-node editors.
import { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { Editor } from '@tiptap/react';

export interface SlashItem {
  key: string;
  label: string;
  hint: string;
  icon: string;
  run: (chain: any) => void;
}

const ALL_ITEMS: SlashItem[] = [
  { key: 'p', label: 'Text', hint: 'Plain paragraph', icon: '¶', run: (c) => c.setParagraph() },
  { key: 'h1', label: 'Heading 1', hint: 'Large section heading', icon: 'H1', run: (c) => c.toggleHeading({ level: 1 }) },
  { key: 'h2', label: 'Heading 2', hint: 'Medium section heading', icon: 'H2', run: (c) => c.toggleHeading({ level: 2 }) },
  { key: 'h3', label: 'Heading 3', hint: 'Small section heading', icon: 'H3', run: (c) => c.toggleHeading({ level: 3 }) },
  { key: 'ul', label: 'Bulleted list', hint: 'Simple bullet list', icon: '•', run: (c) => c.toggleBulletList() },
  { key: 'ol', label: 'Numbered list', hint: 'Ordered list', icon: '1.', run: (c) => c.toggleOrderedList() },
  { key: 'task', label: 'Checklist', hint: 'Tasks with checkboxes', icon: '☑', run: (c) => c.toggleTaskList() },
  { key: 'quote', label: 'Quote', hint: 'Blockquote', icon: '❝', run: (c) => c.toggleBlockquote() },
  { key: 'code', label: 'Code block', hint: 'Monospaced code with syntax highlight', icon: '</>', run: (c) => c.setCodeBlock() },
  { key: 'hr', label: 'Divider', hint: 'Horizontal rule', icon: '—', run: (c) => c.insertContent({ type: 'horizontalRule' }) },
];

export interface SlashState { x: number; y: number; query: string; }

export function useSlashMenu(editor: Editor | null) {
  const [slash, setSlash] = useState<SlashState | null>(null);
  const [slashIdx, setSlashIdx] = useState(0);
  const apiRef = useRef<{ items: SlashItem[]; idx: number; run: (i: number) => void; close: () => void } | null>(null);

  const closeSlash = useCallback(() => { setSlash(null); setSlashIdx(0); }, []);

  const runItem = useCallback((item: SlashItem) => {
    if (!editor) return;
    const { state } = editor;
    const from = state.selection.from;
    const $from = state.doc.resolve(from);
    const chain = editor.chain().focus().deleteRange({ from: $from.start(), to: from });
    item.run(chain);
    chain.run();
    closeSlash();
  }, [editor, closeSlash]);

  const items = slash ? ALL_ITEMS.filter((it) => it.label.toLowerCase().includes(slash.query.toLowerCase())) : [];

  // keep the palette API fresh for the DOM keydown listener
  useEffect(() => {
    apiRef.current = {
      items,
      idx: slashIdx,
      run: (i) => { const it = items[i]; if (it) runItem(it); },
      close: closeSlash,
    };
  }, [items, slashIdx, runItem, closeSlash]);

  // slash detection + keyboard navigation.
  // Listener goes on `document` in the capture phase so it runs BEFORE
  // ProseMirror's own keydown handling; only keys are intercepted while the
  // palette is actually open (non-open editors early-return).
  useEffect(() => {
    if (!editor) return;

    const onKeyDown = (e: KeyboardEvent) => {
      const api = apiRef.current;
      if (!api || api.items.length === 0) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); setSlashIdx((i) => (i + 1) % api.items.length); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); setSlashIdx((i) => (i - 1 + api.items.length) % api.items.length); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); api.run(api.idx); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); api.close(); }
    };
    document.addEventListener('keydown', onKeyDown, true);

    const checkSlash = () => {
      if (!editor) return;
      const { selection } = editor.state;
      const $from = selection.$from;
      if (!$from.parent.isTextblock || $from.parent.type.name === 'codeBlock') { closeSlash(); return; }
      const text = $from.parent.textContent;
      const pos = editor.state.selection.from;
      const coords = editor.view.coordsAtPos(pos);
      if (apiRef.current) {
        if (text.startsWith('/')) {
          setSlash({ x: Math.max(8, coords.left), y: coords.bottom + 4, query: text.slice(1) });
        } else {
          closeSlash();
        }
      } else if (text === '/' && pos === $from.start() + 1) {
        setSlash({ x: Math.max(8, coords.left), y: coords.bottom + 4, query: '' });
        setSlashIdx(0);
      }
    };
    editor.on('transaction', checkSlash);
    editor.on('blur', closeSlash);

    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      editor.off('transaction', checkSlash);
      editor.off('blur', closeSlash);
    };
  }, [editor, closeSlash]);

  return { slash, slashIdx, items, runItem, setSlashIdx };
}

export function SlashMenuView({ slash, items, slashIdx, onPick, onHover }: {
  slash: SlashState;
  items: SlashItem[];
  slashIdx: number;
  onPick: (item: SlashItem) => void;
  onHover: (i: number) => void;
}) {
  return createPortal(
    <div className="slash-menu" style={{ left: slash.x, top: slash.y }}>
      {items.length === 0 && <div className="slash-empty">No matching block</div>}
      {items.map((it, i) => (
        <div
          key={it.key}
          className={`slash-item ${i === slashIdx % Math.max(1, items.length) ? 'active' : ''}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(it)}
          onMouseEnter={() => onHover(i)}
        >
          <span className="slash-icon">{it.icon}</span>
          <span className="slash-meta">
            <span className="slash-label">{it.label}</span>
            <span className="slash-hint">{it.hint}</span>
          </span>
        </div>
      ))}
    </div>,
    document.body
  );
}
