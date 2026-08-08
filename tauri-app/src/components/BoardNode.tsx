import { useRef, useState, useCallback, useEffect } from 'react';
import type { BoardNode as NodeType } from '../lib/types';
import { useBoardStore } from '../store/boardStore';
import { useEditor, EditorContent, BubbleMenu } from '@tiptap/react';
import { editorExtensions } from '../lib/editor/extensions';
import { useSlashMenu, SlashMenuView } from './editor/slashMenu';
import { BubbleFormatBar, StaticToolbar } from './editor/format';

interface Props {
  node: NodeType;
  zoom: number;
  onConnectStart?: (nodeId: string, e: React.PointerEvent) => void;
}

const COLORS = ['', 'var(--sp1)', 'var(--sp2)', 'var(--sp3)', 'var(--sp4)', 'var(--sp5)'];

function nodeColor(c: number): string {
  if (c < 1 || c > 5) return 'var(--accent)';
  return COLORS[c];
}

export function BoardNode({ node, zoom, onConnectStart }: Props) {
  const { selectedIds, selectNode, updateNode, deleteNode, scheduleSave } = useBoardStore();
  const isSelected = selectedIds.has(node.id);
  const dragData = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const resizeData = useRef<{ sx: number; sy: number; ow: number; oh: number } | null>(null);

  const onHeadPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('.node-tool')) return;
    e.stopPropagation();

    // shift-click toggles selection; plain click selects only this
    if (e.shiftKey) {
      selectNode(node.id, true);
      return;
    }
    if (!selectedIds.has(node.id)) selectNode(node.id);

    // group drag: move all selected nodes
    const state = useBoardStore.getState();
    const selectedNodes = state.nodes.filter((n) => state.selectedIds.has(n.id));
    const dragSet = selectedNodes.length > 1 ? selectedNodes : [node];
    const origins = dragSet.map((n) => ({ id: n.id, x: n.x, y: n.y }));

    dragData.current = { sx: e.clientX, sy: e.clientY, ox: node.x, oy: node.y };
    let dragging = false;
    let rafPending = false;

    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - e.clientX) / zoom;
      const dy = (ev.clientY - e.clientY) / zoom;
      if (!dragging) {
        if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
        dragging = true;
      }
      origins.forEach((o) => {
        updateNode(o.id, { x: o.x + dx, y: o.y + dy });
      });
      if (!rafPending) {
        rafPending = true;
        requestAnimationFrame(() => { rafPending = false; });
      }
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      if (dragging) scheduleSave();
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }, [node, zoom, selectNode, selectedIds, updateNode, scheduleSave]);

  const onResizePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    selectNode(node.id);

    resizeData.current = { sx: e.clientX, sy: e.clientY, ow: node.w, oh: node.h };
    let dragging = false;

    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - e.clientX) / zoom;
      const dy = (ev.clientY - e.clientY) / zoom;
      if (!dragging) {
        if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
        dragging = true;
      }
      updateNode(node.id, {
        w: Math.max(150, node.w + dx),
        h: Math.max(90, node.h + dy),
      });
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      if (dragging) scheduleSave();
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }, [node, zoom, selectNode, updateNode, scheduleSave]);

  // --- Inline rich text editor (TipTap) ---
  const isImage = node.kind === 'image' && !!node.image;
  const skipSyncRef = useRef(false);

  const editor = useEditor({
    extensions: editorExtensions('Type…'),
    content: '',
    editorProps: { attributes: { dir: 'auto' } },
    onUpdate: ({ editor: ed }) => {
      if (skipSyncRef.current) return;
      updateNode(node.id, { text: ed.getHTML(), blocks: JSON.stringify(ed.getJSON()) });
      scheduleSave();
    },
    onCreate: ({ editor: ed }) => {
      skipSyncRef.current = true;
      if (node.blocks) {
        try { ed.commands.setContent(JSON.parse(node.blocks)); } catch { ed.commands.setContent(node.text || ''); }
      } else {
        ed.commands.setContent(node.text || '', false);
      }
      skipSyncRef.current = false;
    },
  });

  // apply content changed elsewhere (e.g. focus mode) — only when it actually
  // differs, so typing never triggers a setContent (which would reset the caret)
  useEffect(() => {
    if (!editor) return;
    let same: boolean;
    if (node.blocks) {
      try { same = JSON.stringify(editor.getJSON()) === node.blocks; } catch { same = false; }
    } else {
      same = editor.getText() === (node.text || '');
    }
    if (same) return;
    skipSyncRef.current = true;
    if (node.blocks) {
      try { editor.commands.setContent(JSON.parse(node.blocks)); } catch { editor.commands.setContent(node.text || '', false); }
    } else {
      editor.commands.setContent(node.text || '', false);
    }
    skipSyncRef.current = false;
  }, [node.blocks, node.text, editor]);

  const { slash, items, slashIdx, runItem, setSlashIdx } = useSlashMenu(editor);

  // --- In-place title editing ---
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const cancelTitleRef = useRef(false);

  const startTitleEdit = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.node-tool')) return;
    e.stopPropagation();
    e.preventDefault();
    cancelTitleRef.current = false;
    setTitleDraft((node as any).customTitle || (node.kind === 'image' ? 'image' : ''));
    setEditingTitle(true);
  }, [node]);

  const commitTitle = useCallback(() => {
    setEditingTitle(false);
    if (cancelTitleRef.current) { cancelTitleRef.current = false; return; }
    const t = titleDraft.trim();
    if (t && t !== ((node as any).customTitle || '')) updateNode(node.id, { customTitle: t } as any);
  }, [titleDraft, node, updateNode]);

  const color = nodeColor(node.c);
  const title = (node as any).customTitle || (node.kind === 'image' ? 'image' : 'Untitled note');

  return (
    <div
      className={`board-node kind-${node.kind} ${isSelected ? 'selected' : ''}`}
      data-id={node.id}
      style={{
        left: node.x, top: node.y, width: node.w, height: node.h,
      }}
    >
      <div className="node-color-bar" style={{ background: color }} />

      <div className="node-head" onPointerDown={onHeadPointerDown} onDoubleClick={startTitleEdit}>
        <span className="node-dot" style={{ background: color }} />
        {editingTitle ? (
          <input
            className="node-title-input"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitTitle(); }
              else if (e.key === 'Escape') { e.stopPropagation(); cancelTitleRef.current = true; (e.target as HTMLInputElement).blur(); }
            }}
            onPointerDown={(e) => e.stopPropagation()}
            dir="auto"
            autoFocus
          />
        ) : (
          <span className="node-title" title="Double-click to rename" dir="auto">
            {title}
          </span>
        )}
        <div className="node-tools">
          <button className="node-tool" title="Color" onClick={(e) => { e.stopPropagation(); /* color popover later */ }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9" /></svg>
          </button>
          <button className="node-tool del" title="Delete" onClick={(e) => { e.stopPropagation(); deleteNode(node.id); }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>
      </div>

      {!isImage && editor && (
        <div className="node-toolbar" onPointerDown={(e) => e.stopPropagation()}>
          <StaticToolbar editor={editor} />
        </div>
      )}

      {isImage ? (
        <div className="node-body image-body">
          <img src={node.image} draggable={false} alt="" />
        </div>
      ) : (
        <div
          className="node-body"
          onPointerDown={(e) => {
            e.stopPropagation();
            if (e.shiftKey) { selectNode(node.id, true); return; }
            if (!selectedIds.has(node.id)) selectNode(node.id);
            // click anywhere in the note body starts typing: place the caret
            // at the clicked position (or at the end when clicking empty space)
            if (!editor) return;
            const t = e.target as HTMLElement;
            if (t.closest('input, button, a, label')) return;
            editor.view.focus();
            const pos = editor.view.posAtCoords({ left: e.clientX, top: e.clientY });
            if (pos) editor.commands.setTextSelection(pos.pos);
            else editor.commands.focus('end');
          }}
        >
          <EditorContent editor={editor} />
        </div>
      )}

      <div className="node-resize" onPointerDown={onResizePointerDown} />

      {/* Connect zone — covers the whole node while the connect tool is active */}
      <div
        className="node-connect-zone"
        onPointerDown={(e) => {
          if (!document.body.classList.contains('tool-connect')) return;
          e.stopPropagation();
          e.preventDefault();
          onConnectStart?.(node.id, e);
        }}
      />

      {/* Floating formatting + slash palette (inside the node) */}
      {editor && !isImage && (
        <>
          <BubbleMenu
            editor={editor}
            tippyOptions={{ duration: 120, maxWidth: 460 }}
            shouldShow={({ editor: ed }) => {
              const { selection } = ed.state;
              return !selection.empty && !ed.isActive('codeBlock');
            }}
          >
            <BubbleFormatBar editor={editor} />
          </BubbleMenu>
          {slash && (
            <SlashMenuView
              slash={slash}
              items={items}
              slashIdx={slashIdx}
              onPick={runItem}
              onHover={setSlashIdx}
            />
          )}
        </>
      )}
    </div>
  );
}
