import { useState, useCallback } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { useBoardStore } from '../store/boardStore';
import { RichEditor, type LinkTargetItem } from './editor/RichEditor';
import { docToMarkdown } from '../lib/editor/markdown';
import { toast } from '../lib/toast';
import { tagChipStyle } from '../store/tagStore';

interface Props {
  nodeId: string;
  onClose: () => void;
  linkTargets?: LinkTargetItem[];
  onAttachImage?: (nodeId: string) => void;
}

export function NoteModal({ nodeId, onClose, linkTargets, onAttachImage }: Props) {
  const { nodes, updateNode, scheduleSave, addNodeTag, removeNodeTag } = useBoardStore();
  const node = nodes.find((n) => n.id === nodeId);
  const [title, setTitle] = useState(node?.customTitle || '');

  const handleChange = useCallback((json: object, html: string) => {
    updateNode(nodeId, { text: html, blocks: JSON.stringify(json) } as any);
    scheduleSave();
  }, [nodeId, updateNode, scheduleSave]);

  const onTitleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setTitle(e.target.value);
    updateNode(nodeId, { customTitle: e.target.value } as any);
    scheduleSave();
  }, [nodeId, updateNode, scheduleSave]);

  const copyMarkdown = useCallback(() => {
    if (!node) return;
    let md = '';
    if (node.blocks) {
      try { md = docToMarkdown(JSON.parse(node.blocks)); } catch { md = ''; }
    }
    if (!md && node.text) {
      const div = document.createElement('div');
      div.innerHTML = node.text;
      md = (div.textContent || '').trim();
    }
    navigator.clipboard.writeText(md || '(empty note)');
    toast('Copied as Markdown.');
  }, [node]);

  if (!node) return null;

  return (
    <div className="note-modal-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="note-modal">
        <div className="note-modal-toolbar">
          <input
            className="note-modal-title"
            value={title}
            onChange={onTitleChange}
            placeholder="Untitled note"
            dir="auto"
          />
          <div className="note-modal-actions">
            {onAttachImage && (
              <button className="btn btn-ghost btn-sm" onClick={() => onAttachImage(nodeId)} title={node.image ? 'Replace note image' : 'Add image to note'}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-5-5L5 21" /></svg>
                {node.image ? 'Replace image' : 'Image'}
              </button>
            )}
            <button className="btn btn-ghost btn-sm" onClick={copyMarkdown} title="Copy as Markdown">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 6h10v14H4zM8 6V4h12v14h-2" /></svg>
              Markdown
            </button>
            <button className="note-modal-close" onClick={onClose} title="Close (Esc)">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 6l12 12M18 6 6 18" /></svg>
            </button>
          </div>
        </div>
        <div className="note-modal-inner">
          {node.image && (
            <div className="note-modal-image">
              <img
                src={convertFileSrc((node.image as string).includes('://') ? ((node.image as string).split('/').pop() || '') : (node.image as string), 'boardimg')}
                alt=""
                draggable={false}
              />
              <button className="note-modal-image-remove" title="Remove image" onClick={() => { updateNode(node.id, { image: '' } as any); scheduleSave(); }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 6l12 12M18 6 6 18" /></svg>
              </button>
            </div>
          )}
          {(node.tags || []).length > 0 && (
            <div className="note-modal-tags">
              {(node.tags || []).map((t) => (
                <span key={t} className="tag-chip c-tag" style={tagChipStyle({ name: t })}>
                  {t}
                  <button className="tag-x" title="Remove tag" onClick={() => removeNodeTag(node.id, t)}>
                    <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M6 6l12 12M18 6 6 18" /></svg>
                  </button>
                </span>
              ))}
              <span className="hint">type # to add a tag</span>
            </div>
          )}
          <RichEditor
            key={node.id}
            blocks={node.blocks}
            html={node.text}
            autofocus
            toolbar
            linkTargets={linkTargets}
            onTagSelect={(tag) => addNodeTag(nodeId, tag)}
            onChange={handleChange}
          />
        </div>
      </div>
    </div>
  );
}
