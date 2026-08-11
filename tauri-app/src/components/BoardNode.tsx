import { useRef, useState, useCallback, useEffect } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import type { BoardNode as NodeType } from '../lib/types';
import { useBoardStore } from '../store/boardStore';
import { useTagStore, tagColor, TAG_COLORS, tagChipStyle } from '../store/tagStore';
import { useEditor, EditorContent, BubbleMenu } from '@tiptap/react';
import { editorExtensions } from '../lib/editor/extensions';
import { useSlashMenu, SlashMenuView } from './editor/slashMenu';
import { useTagMenu, TagMenuView } from './editor/tagMenu';
import { BubbleFormatBar, StaticToolbar, type LinkTargetItem } from './editor/format';
import { htmlToText } from '../lib/editor/markdown';

interface Props {
  node: NodeType;
  zoom: number;
  linkTargets?: LinkTargetItem[];
  onConnectStart?: (nodeId: string, e: React.PointerEvent) => void;
  onPreview?: (src: string) => void;
  onOpenWorkspace?: (nodeId: string) => void;
  onAddImage?: (nodeId: string) => void;
  // quick-add a note/image card straight into a container (group)
  onAddChild?: (nodeId: string, kind: 'note' | 'reference') => void;
  contained?: NodeType[];
  // drag-to-add into a container: hover reports the cursor during a node drag,
  // dragEnd fires on release (moved = an actual drag, not a click)
  onDragMove?: (nodeId: string, clientX: number, clientY: number) => void;
  onDragEnd?: (nodeId: string, clientX: number, clientY: number, moved: boolean) => void;
  dropTarget?: boolean;
}

const COLORS = ['', 'var(--sp1)', 'var(--sp2)', 'var(--sp3)', 'var(--sp4)', 'var(--sp5)'];

// Wheel-zoom while hovering an image: scroll scales the image up to 8× /
// down to 50%, resets when the pointer leaves. Stops the event so the board
// itself never zooms while an image is hovered.
function useImageWheelZoom() {
  const [scale, setScale] = useState(1);
  const onWheel = useCallback((e: React.WheelEvent) => {
    e.stopPropagation();
    setScale((s) => Math.min(8, Math.max(0.5, s * (e.deltaY < 0 ? 1.15 : 1 / 1.15))));
  }, []);
  const onLeave = useCallback(() => setScale(1), []);
  return { scale, onWheel, onLeave };
}

function nodeColor(c: number): string {
  if (c < 1 || c > 5) return 'var(--accent)';
  return COLORS[c];
}

export function BoardNode({ node, zoom, linkTargets, onConnectStart, onPreview, onOpenWorkspace, onAddImage, onAddChild, contained, onDragMove, onDragEnd, dropTarget }: Props) {
  const {
    selectedIds, selectNode, updateNode, deleteNode, scheduleSave,
    tagFilter, setTagFilter, addNodeTag, removeNodeTag,
  } = useBoardStore();
  const knownTags = useTagStore((s) => s.tags);
  const isSelected = selectedIds.has(node.id);
  const dragData = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const resizeData = useRef<{ sx: number; sy: number; ox: number; oy: number; ow: number; oh: number; dir: string } | null>(null);

  // drag the node by grabbing it (head or image body)
  const startDrag = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (!selectedIds.has(node.id)) selectNode(node.id);

    // group drag: move all selected nodes
    const state = useBoardStore.getState();
    const selectedNodes = state.nodes.filter((n) => state.selectedIds.has(n.id));
    const dragSet = selectedNodes.length > 1 ? selectedNodes : [node];
    const origins = dragSet.map((n) => ({ id: n.id, x: n.x, y: n.y }));

    dragData.current = { sx: e.clientX, sy: e.clientY, ox: node.x, oy: node.y };
    let dragging = false;
    let lastX = e.clientX, lastY = e.clientY;

    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - e.clientX) / zoom;
      const dy = (ev.clientY - e.clientY) / zoom;
      if (!dragging) {
        if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
        dragging = true;
      }
      lastX = ev.clientX; lastY = ev.clientY;
      origins.forEach((o) => {
        updateNode(o.id, { x: o.x + dx, y: o.y + dy });
      });
      if (onDragMove) onDragMove(node.id, ev.clientX, ev.clientY);
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      if (dragging) {
        scheduleSave();
        if (onDragEnd) onDragEnd(node.id, lastX, lastY, true);
      } else if (onDragEnd) {
        onDragEnd(node.id, lastX, lastY, false);
      }
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }, [node, zoom, selectNode, selectedIds, updateNode, scheduleSave, onDragMove, onDragEnd]);

  const onHeadPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('.node-tool')) return;
    if (e.shiftKey) {
      selectNode(node.id, true);
      return;
    }
    startDrag(e);
  }, [startDrag, selectNode, node.id]);

  const onResizePointerDown = useCallback((e: React.PointerEvent, dir: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    selectNode(node.id);

    resizeData.current = { sx: e.clientX, sy: e.clientY, ox: node.x, oy: node.y, ow: node.w, oh: node.h, dir };
    let dragging = false;

    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - e.clientX) / zoom;
      const dy = (ev.clientY - e.clientY) / zoom;
      if (!dragging) {
        if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
        dragging = true;
      }
      const rd = resizeData.current!;
      let w = rd.ow, h = rd.oh;
      if (rd.dir.includes('e')) w += dx;
      if (rd.dir.includes('w')) w -= dx;
      if (rd.dir.includes('s')) h += dy;
      if (rd.dir.includes('n')) h -= dy;
      w = Math.max(200, w);
      h = Math.max(120, h);
      // keep the opposite edge fixed while resizing
      const x = rd.dir.includes('w') ? rd.ox + (rd.ow - w) : rd.ox;
      const y = rd.dir.includes('n') ? rd.oy + (rd.oh - h) : rd.oy;
      updateNode(node.id, { w, h, x, y });
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
  const isRef = node.kind === 'reference' && !!node.image;
  const isContainer = node.kind === 'node';
  const isGroup = node.kind === 'group';
  // image ids are stored raw; legacy entries may hold a boardimg:// URL
  const imgSrc = node.image
    ? convertFileSrc(node.image.includes('://') ? (node.image.split('/').pop() || '') : node.image, 'boardimg')
    : '';
  const thumbSrc = (img: string) =>
    img ? convertFileSrc(img.includes('://') ? (img.split('/').pop() || '') : img, 'boardimg') : '';
  const firstLine = (t: string) => {
    const l = (t || '').split('\n').find((x) => x.trim());
    return l ? htmlToText(l).slice(0, 42) : 'Untitled note';
  };
  const noteSnippet = (t: string) => {
    const ls = (t || '').split('\n').filter((x) => x.trim());
    return htmlToText(ls.slice(1).join(' ') || ls[0] || '').slice(0, 80) || 'Empty note';
  };
  const children = contained || [];
  const notesCount = children.filter((ch) => ch.kind === 'note').length;
  const imagesCount = children.filter((ch) => ch.kind === 'reference').length;
  const skipSyncRef = useRef(false);
  const imgZoom = useImageWheelZoom();
  const noteImgZoom = useImageWheelZoom();

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

  // #-tag menu — typing `#word` offers existing tags / creates a new one
  const { tagMenu, tagItems, tagIdx, pickTag, setTagIdx } = useTagMenu(
    editor,
    (tag) => addNodeTag(node.id, tag),
  );

  // add-tag popover (+ button next to the chips)
  const [tagPop, setTagPop] = useState(false);
  const [tagDraft, setTagDraft] = useState('');
  const tagPopRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!tagPop) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('.tag-pop') || t.closest('.tag-add')) return;
      setTagPop(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [tagPop]);

  // --- In-place title editing ---
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const cancelTitleRef = useRef(false);

  const startTitleEdit = useCallback((e: React.MouseEvent) => {
    if (isContainer && !isGroup) return; // containers are renamed inside the workspace
    if ((e.target as HTMLElement).closest('.node-tool')) return;
    e.stopPropagation();
    e.preventDefault();
    cancelTitleRef.current = false;
    setTitleDraft((node as any).customTitle || '');
    setEditingTitle(true);
  }, [node, isContainer, isGroup]);

  const commitTitle = useCallback(() => {
    setEditingTitle(false);
    if (cancelTitleRef.current) { cancelTitleRef.current = false; return; }
    const t = titleDraft.trim();
    if (t && t !== ((node as any).customTitle || '')) updateNode(node.id, { customTitle: t } as any);
  }, [titleDraft, node, updateNode]);

  const color = nodeColor(node.c);
  const title = (node as any).customTitle
    || (node.kind === 'reference' ? 'Reference' : node.kind === 'node' ? 'Untitled node' : node.kind === 'group' ? 'Group' : 'Untitled note');

  return (
    <div
      className={`board-node kind-${node.kind} ${isSelected ? 'selected' : ''} ${dropTarget ? 'drop-target' : ''} ${tagFilter && !(node.tags || []).includes(tagFilter) ? 'tag-dim' : ''}`}
      data-id={node.id}
      style={{
        left: node.x, top: node.y, width: node.w, height: node.h,
        // UI scale: text + toolbar grow with the note's width (clamped)
        ['--ns' as any]: Math.min(1.5, Math.max(0.85, node.w / 400)),
      }}
    >
      <div className="node-color-bar" style={{ background: color }} />

      <div className="node-head" onPointerDown={onHeadPointerDown} onDoubleClick={isContainer && !isGroup ? (e) => { e.stopPropagation(); onOpenWorkspace?.(node.id); } : startTitleEdit}>
        <span className="node-dot" style={{ background: color }} />
        {isContainer && (
          <svg className="node-kind-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></svg>
        )}
        {isContainer && <span className="node-count">{children.length}</span>}
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
          {isContainer && onAddChild && (
            <>
              <button className="node-tool" title="Add note to group" onClick={(e) => { e.stopPropagation(); onAddChild(node.id, 'note'); }}>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"><path d="M12 5v14M5 12h14" /><path d="M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" /></svg>
              </button>
              <button className="node-tool" title="Add image to group" onClick={(e) => { e.stopPropagation(); onAddChild(node.id, 'reference'); }}>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"><path d="M12 5v14M5 12h14" /><rect x="3" y="3" width="18" height="18" rx="2" /></svg>
              </button>
            </>
          )}
          {isContainer && (
            <button className="node-tool" title="Open node" onClick={(e) => { e.stopPropagation(); onOpenWorkspace?.(node.id); }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" /></svg>
            </button>
          )}
          <button className="node-tool del" title="Delete" onClick={(e) => { e.stopPropagation(); deleteNode(node.id); }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>
      </div>

      {(node.tags || []).length > 0 || (isSelected && !isGroup) ? (
        <div className="node-tags">
          {(node.tags || []).map((t) => (
            <span
              key={t}
              className={`tag-chip c-tag ${tagFilter === t ? 'active' : ''}`}
              style={tagChipStyle({ name: t })}
              title={`Filter by #${t}`}
              onClick={(e) => { e.stopPropagation(); setTagFilter(tagFilter === t ? null : t); }}
            >
              {t}
              <button
                className="tag-x"
                title="Remove tag"
                onClick={(ev) => { ev.stopPropagation(); removeNodeTag(node.id, t); }}
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M6 6l12 12M18 6 6 18" /></svg>
              </button>
            </span>
          ))}
          <button
            className="tag-add"
            title="Add tag"
            onClick={(e) => { e.stopPropagation(); setTagPop(true); }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14" /></svg>
          </button>
          {tagPop && (
            <div className="tag-pop" ref={tagPopRef}>
              <input
                autoFocus
                className="tag-input"
                placeholder="Tag name…"
                value={tagDraft}
                onChange={(e) => setTagDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); addNodeTag(node.id, tagDraft); setTagDraft(''); setTagPop(false); }
                  else if (e.key === 'Escape') { setTagPop(false); setTagDraft(''); }
                }}
              />
              <div className="tag-sug">
                {knownTags.filter((t) => t.name.includes(tagDraft.trim().toLowerCase())).slice(0, 6).map((t) => (
                  <button key={t.name} onMouseDown={(e) => e.preventDefault()} onClick={() => { addNodeTag(node.id, t.name); setTagPop(false); setTagDraft(''); }}>
                    <span className="tag-dot" style={{ background: TAG_COLORS[tagColor(t) - 1] }} />
                    {t.name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : null}

      {node.kind === 'note' && editor && (
        <div className="node-toolbar" onPointerDown={(e) => e.stopPropagation()}>
          <StaticToolbar editor={editor} linkTargets={linkTargets} />
          {onAddImage && (
            <button className="bubble-btn" title="Add image to note" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onAddImage(node.id); }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-5-5L5 21" /></svg>
            </button>
          )}
        </div>
      )}

      {isRef ? (
        <div
          className="node-body image-body"
          onPointerDown={(e) => {
            e.stopPropagation();
            if (e.shiftKey) { selectNode(node.id, true); return; }
            startDrag(e);
          }}
          onDoubleClick={(e) => { e.stopPropagation(); if (imgSrc) onPreview?.(imgSrc); }}
          onWheel={imgZoom.onWheel}
          onPointerLeave={imgZoom.onLeave}
        >
          <img
            src={imgSrc}
            draggable={false}
            alt=""
            style={{ transform: imgZoom.scale !== 1 ? `scale(${imgZoom.scale})` : undefined }}
          />
          {imgZoom.scale !== 1 && (
            <span className="img-zoom-badge">{Math.round(imgZoom.scale * 100)}%</span>
          )}
          {onPreview && imgSrc && (
            <button
              className="img-preview-btn"
              title="Preview image"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onPreview(imgSrc); }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.35-4.35M8 11h6M11 8v6" /></svg>
            </button>
          )}
        </div>
      ) : isGroup ? (
        <div
          className="group-body"
          onPointerDown={(e) => {
            e.stopPropagation();
            if (e.shiftKey) { selectNode(node.id, true); return; }
            startDrag(e);
          }}
          onDoubleClick={(e) => { e.stopPropagation(); startTitleEdit(e as any); }}
        />
      ) : isContainer ? (
        <div
          className={`node-body container-body ${dropTarget ? 'drop-target' : ''}`}
          onPointerDown={(e) => {
            e.stopPropagation();
            if (!selectedIds.has(node.id)) selectNode(node.id);
          }}
          onDoubleClick={(e) => { e.stopPropagation(); onOpenWorkspace?.(node.id); }}
        >
          <div className="container-preview">
            {children.length === 0 ? (
              <span className="container-empty">Empty node — double-click to open</span>
            ) : children.slice(0, 6).map((ch) => ch.kind === 'reference' ? (
              <span key={ch.id} className="container-thumb" title="Reference">
                <img src={thumbSrc(ch.image)} draggable={false} alt="" />
              </span>
            ) : (
              <span key={ch.id} className="container-item">
                <span className="container-item-title">{ch.customTitle || firstLine(ch.text)}</span>
                <span className="container-item-snippet">{noteSnippet(ch.text)}</span>
              </span>
            ))}
          </div>
          <div className="container-foot">
            <span className="container-counts">
              {children.length === 0 ? 'empty' : `${notesCount} ${notesCount === 1 ? 'note' : 'notes'} · ${imagesCount} ${imagesCount === 1 ? 'image' : 'images'}`}
            </span>
            <span className="container-open">Open <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M13 6l6 6-6 6" /></svg></span>
          </div>
          {dropTarget && (
            <div className="drop-overlay">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14" /></svg>
              <span>Drop to add</span>
            </div>
          )}
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
          {node.image && imgSrc && (
            <div
              className="note-image"
              title="Preview image — scroll to zoom"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onPreview?.(imgSrc); }}
              onWheel={noteImgZoom.onWheel}
              onPointerLeave={noteImgZoom.onLeave}
            >
              <img
                src={imgSrc}
                draggable={false}
                alt=""
                style={{ transform: noteImgZoom.scale !== 1 ? `scale(${noteImgZoom.scale})` : undefined }}
              />
              {noteImgZoom.scale !== 1 && (
                <span className="img-zoom-badge">{Math.round(noteImgZoom.scale * 100)}%</span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Resize handles — every edge and corner */}
      {(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const).map((d) => (
        <div
          key={d}
          className={`node-resize ${d}`}
          onPointerDown={(e) => onResizePointerDown(e, d)}
        />
      ))}

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

      {/* Connection ports — grab one to draw an edge to another node */}
      <div className="node-ports">
        {(['p-t', 'p-r', 'p-b', 'p-l'] as const).map((p) => (
          <div
            key={p}
            className={`node-port ${p}`}
            onPointerDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
              onConnectStart?.(node.id, e);
            }}
          />
        ))}
      </div>

      {/* Floating formatting + slash palette (inside the node) */}
      {editor && node.kind === 'note' && (
        <>
          <BubbleMenu
            editor={editor}
            tippyOptions={{ duration: 120, maxWidth: 460 }}
            shouldShow={({ editor: ed }) => {
              const { selection } = ed.state;
              return !selection.empty && !ed.isActive('codeBlock');
            }}
          >
            <BubbleFormatBar editor={editor} linkTargets={linkTargets} />
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
          {tagMenu && (
            <TagMenuView
              menu={tagMenu}
              items={tagItems}
              idx={tagIdx}
              onPick={pickTag}
              onHover={setTagIdx}
            />
          )}
        </>
      )}
    </div>
  );
}
