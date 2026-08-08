import { useState, useCallback } from 'react';
import { useBoardStore } from '../store/boardStore';
import { RichEditor } from './editor/RichEditor';
import { docToMarkdown } from '../lib/editor/markdown';
import { toast } from '../lib/toast';

interface Props {
  nodeId: string;
  onClose: () => void;
}

export function NoteModal({ nodeId, onClose }: Props) {
  const { nodes, updateNode, scheduleSave } = useBoardStore();
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
          <RichEditor
            key={node.id}
            blocks={node.blocks}
            html={node.text}
            autofocus
            toolbar
            onChange={handleChange}
          />
        </div>
      </div>
    </div>
  );
}
