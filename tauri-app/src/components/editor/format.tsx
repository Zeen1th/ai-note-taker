// Shared formatting UI: the floating bubble bar (text selection) and the
// static toolbar shown under the note title. Both bind to any TipTap editor.
import { useState } from 'react';
import type { Editor } from '@tiptap/react';
import { showPrompt, showCustom } from '../../lib/dialogs';
import type { InternalLinkTarget } from '../../lib/editor/extensions';

export const TEXT_COLORS = ['#e5484d', '#f76b15', '#46a758', '#3e63dd', '#8e4ec6', '#6e56cf', '#64748b'];
export const HIGHLIGHTS = ['#fff3bf', '#c5f8cf', '#d0ebff', '#ffe3ec', '#ffe5cc'];

// An item the link picker can target — every node visible on the current view.
export type LinkTargetItem = { type: InternalLinkTarget['type']; id: string; label: string; sub?: string };

const TARGET_ICONS: Record<LinkTargetItem['type'], React.ReactNode> = {
  note: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M5 4h14v16H5z" /><path d="M9 8h6M9 12h6M9 16h4" /></svg>,
  reference: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-5-5L5 21" /></svg>,
  node: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></svg>,
  group: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="4" y="4" width="16" height="16" rx="2" strokeDasharray="3 2" /></svg>,
};

function LinkPickerBody({ targets, onPick, onExternal, onRemove }: {
  targets: LinkTargetItem[];
  onPick: (t: LinkTargetItem) => void;
  onExternal: () => void;
  onRemove: () => void;
}) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const list = q ? targets.filter((t) => (t.label + ' ' + (t.sub || '')).toLowerCase().includes(q)) : targets;

  return (
    <div className="link-picker">
      <input
        className="input dialog-input link-picker-search"
        autoFocus
        placeholder="Search notes, nodes, groups…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="link-picker-list">
        {list.length === 0 && <div className="link-picker-empty">Nothing here yet — add a note, image, node or group first.</div>}
        {list.map((t) => (
          <button key={t.id} className="link-item" onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(t)}>
            <span className="link-item-icon">{TARGET_ICONS[t.type]}</span>
            <span className="link-item-text">
              <span className="link-item-label">{t.label}</span>
              {t.sub && <span className="link-item-sub">{t.sub}</span>}
            </span>
            <span className="link-item-kind">{t.type}</span>
          </button>
        ))}
      </div>
      <div className="dialog-actions">
        <button className="btn btn-ghost" onClick={onRemove}>Remove link</button>
        <button className="btn btn-ghost" onClick={onExternal}>External URL…</button>
      </div>
    </div>
  );
}

function openLinkPicker(editor: Editor, targets: LinkTargetItem[]) {
  showCustom('Link selected text to', (close) => (
    <LinkPickerBody
      targets={targets}
      onPick={(t) => {
        close();
        editor.chain().focus().extendMarkRange('internalLink').setInternalLink(t.type, t.id).run();
      }}
      onExternal={() => {
        close();
        void insertLink(editor);
      }}
      onRemove={() => {
        close();
        editor.chain().focus().extendMarkRange('internalLink').unsetInternalLink().run();
      }}
    />
  ));
}

// em-based steps: scale relative to the editor's base font size.
const FONT_SIZES = ['0.85em', '1em', '1.15em', '1.35em', '1.6em', '1.9em', '2.3em'];
const BASE_SIZE_INDEX = 1;

export const FONTS: { label: string; value: string }[] = [
  { label: 'Default', value: '' },
  { label: 'Serif', value: 'Georgia, "Times New Roman", serif' },
  { label: 'Sans', value: '"Segoe UI", system-ui, sans-serif' },
  { label: 'Monospace', value: '"Cascadia Code", Consolas, monospace' },
  { label: 'Arial', value: 'Arial, Helvetica, sans-serif' },
  { label: 'Verdana', value: 'Verdana, Geneva, sans-serif' },
  { label: 'Tahoma', value: 'Tahoma, "Segoe UI", sans-serif' },
  { label: 'Trebuchet', value: '"Trebuchet MS", "Segoe UI", sans-serif' },
  { label: 'Times', value: '"Times New Roman", Times, serif' },
  { label: 'Garamond', value: 'Garamond, "Times New Roman", serif' },
  { label: 'Courier', value: '"Courier New", Courier, monospace' },
  { label: 'Consolas', value: 'Consolas, "Cascadia Code", monospace' },
  { label: 'Handwriting', value: '"Segoe Script", "Comic Sans MS", cursive' },
];

function currentSizeIndex(editor: Editor) {
  const cur = editor.getAttributes('textStyle').fontSize as string | null;
  if (!cur) return BASE_SIZE_INDEX;
  const i = FONT_SIZES.indexOf(cur);
  return i === -1 ? BASE_SIZE_INDEX : i;
}

// apply a TextStyle attribute either to the selection, or — when nothing is
// selected — to the whole document (so A+/A− scales the entire note's text).
function applyTextStyleAttr(editor: Editor, attr: string, value: string | null) {
  const { from, to } = editor.state.selection;
  const empty = from === to;
  const sel = empty
    ? { from: 1, to: editor.state.doc.content.size }
    : { from, to };
  const chain = editor.chain().focus().setTextSelection(sel).setMark('textStyle', { [attr]: value ?? null });
  chain.setTextSelection({ from, to }).run();
}

function changeSize(editor: Editor, delta: number) {
  const i = Math.min(FONT_SIZES.length - 1, Math.max(0, currentSizeIndex(editor) + delta));
  applyTextStyleAttr(editor, 'fontSize', FONT_SIZES[i]);
}

function changeFont(editor: Editor, family: string) {
  applyTextStyleAttr(editor, 'fontFamily', family || null);
}

function currentFontValue(editor: Editor): string {
  return (editor.getAttributes('textStyle').fontFamily as string | null) || '';
}

async function insertLink(editor: Editor) {
  const url = await showPrompt({ title: 'Insert link', initial: '', placeholder: 'https://…' });
  if (url) {
    editor.chain().focus().extendMarkRange('link').setLink({ href: url, target: '_blank' }).run();
  }
}

function FBtn({ editor: _editor, active, title, onClick, children }: {
  editor: Editor;
  active: boolean;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`bubble-btn ${active ? 'active' : ''}`}
      title={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function BubbleFormatBar({ editor, linkTargets = [] }: { editor: Editor; linkTargets?: LinkTargetItem[] }) {
  return (
    <div className="bubble-menu">
      <FBtn editor={editor} active={editor.isActive('bold')} title="Bold (Ctrl+B)" onClick={() => editor.chain().focus().toggleBold().run()}><b>B</b></FBtn>
      <FBtn editor={editor} active={editor.isActive('italic')} title="Italic (Ctrl+I)" onClick={() => editor.chain().focus().toggleItalic().run()}><i>I</i></FBtn>
      <FBtn editor={editor} active={editor.isActive('underline')} title="Underline (Ctrl+U)" onClick={() => editor.chain().focus().toggleUnderline().run()}><u>U</u></FBtn>
      <FBtn editor={editor} active={editor.isActive('strike')} title="Strikethrough" onClick={() => editor.chain().focus().toggleStrike().run()}><s>S</s></FBtn>
      <FBtn editor={editor} active={editor.isActive('code')} title="Inline code" onClick={() => editor.chain().focus().toggleCode().run()}>&lt;/&gt;</FBtn>
      <FBtn editor={editor} active={editor.isActive('internalLink')} title="Link to a note, node, group or image" onClick={() => openLinkPicker(editor, linkTargets)}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>
      </FBtn>
      <span className="bubble-sep" />
      <span className="bubble-group">
        {TEXT_COLORS.map((c) => (
          <button key={c} className="bubble-swatch" style={{ background: c }} title="Text color" onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().setColor(c).run()} />
        ))}
        <FBtn editor={editor} active={false} title="Reset text color" onClick={() => editor.chain().focus().unsetColor().run()}>×</FBtn>
      </span>
      <span className="bubble-group">
        {HIGHLIGHTS.map((c) => (
          <button key={c} className="bubble-swatch" style={{ background: c }} title="Highlight" onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().toggleHighlight({ color: c }).run()} />
        ))}
        <FBtn editor={editor} active={false} title="Remove highlight" onClick={() => editor.chain().focus().unsetHighlight().run()}>×</FBtn>
      </span>
    </div>
  );
}

export function StaticToolbar({ editor, linkTargets = [] }: { editor: Editor; linkTargets?: LinkTargetItem[] }) {
  return (
    <div className="rich-toolbar">
      <FBtn editor={editor} active={editor.isActive('paragraph')} title="Paragraph" onClick={() => editor.chain().focus().setParagraph().run()}>¶</FBtn>
      <FBtn editor={editor} active={editor.isActive('heading', { level: 1 })} title="Heading 1" onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}>H1</FBtn>
      <FBtn editor={editor} active={editor.isActive('heading', { level: 2 })} title="Heading 2" onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>H2</FBtn>
      <FBtn editor={editor} active={editor.isActive('heading', { level: 3 })} title="Heading 3" onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}>H3</FBtn>
      <span className="bubble-sep" />
      <span className="bubble-group font-group">
        <select
          className="font-select"
          value={currentFontValue(editor)}
          title="Font family"
          onChange={(e) => changeFont(editor, e.target.value)}
        >
          {FONTS.map((f) => (
            <option key={f.label} value={f.value} style={f.value ? { fontFamily: f.value } : undefined}>
              {f.label}
            </option>
          ))}
        </select>
      </span>
      <span className="bubble-sep" />
      <FBtn editor={editor} active={false} title="Smaller text" onClick={() => changeSize(editor, -1)}>A−</FBtn>
      <FBtn editor={editor} active={false} title="Larger text" onClick={() => changeSize(editor, 1)}>A+</FBtn>
      <FBtn editor={editor} active={false} title="Reset text size" onClick={() => applyTextStyleAttr(editor, 'fontSize', null)}>A↺</FBtn>
      <span className="bubble-sep" />
      <FBtn editor={editor} active={editor.isActive({ textAlign: 'left' })} title="Align left" onClick={() => editor.chain().focus().setTextAlign('left').run()}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 6h16M4 10h10M4 14h16M4 18h10" /></svg>
      </FBtn>
      <FBtn editor={editor} active={editor.isActive({ textAlign: 'center' })} title="Align center" onClick={() => editor.chain().focus().setTextAlign('center').run()}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 6h16M7 10h10M4 14h16M7 18h10" /></svg>
      </FBtn>
      <FBtn editor={editor} active={editor.isActive({ textAlign: 'right' })} title="Align right" onClick={() => editor.chain().focus().setTextAlign('right').run()}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 6h16M10 10h10M4 14h16M10 18h10" /></svg>
      </FBtn>
      <span className="bubble-sep" />
      <FBtn editor={editor} active={editor.isActive('bold')} title="Bold (Ctrl+B)" onClick={() => editor.chain().focus().toggleBold().run()}><b>B</b></FBtn>
      <FBtn editor={editor} active={editor.isActive('italic')} title="Italic (Ctrl+I)" onClick={() => editor.chain().focus().toggleItalic().run()}><i>I</i></FBtn>
      <FBtn editor={editor} active={editor.isActive('underline')} title="Underline (Ctrl+U)" onClick={() => editor.chain().focus().toggleUnderline().run()}><u>U</u></FBtn>
      <FBtn editor={editor} active={editor.isActive('strike')} title="Strikethrough" onClick={() => editor.chain().focus().toggleStrike().run()}><s>S</s></FBtn>
      <FBtn editor={editor} active={editor.isActive('code')} title="Inline code" onClick={() => editor.chain().focus().toggleCode().run()}>&lt;/&gt;</FBtn>
      <FBtn editor={editor} active={editor.isActive('internalLink')} title="Link to a note, node, group or image" onClick={() => openLinkPicker(editor, linkTargets)}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>
      </FBtn>
      <span className="bubble-sep" />
      <FBtn editor={editor} active={editor.isActive('bulletList')} title="Bulleted list" onClick={() => editor.chain().focus().toggleBulletList().run()}>•</FBtn>
      <FBtn editor={editor} active={editor.isActive('orderedList')} title="Numbered list" onClick={() => editor.chain().focus().toggleOrderedList().run()}>1.</FBtn>
      <FBtn editor={editor} active={editor.isActive('taskList')} title="Checklist" onClick={() => editor.chain().focus().toggleTaskList().run()}>☑</FBtn>
      <FBtn editor={editor} active={editor.isActive('blockquote')} title="Quote" onClick={() => editor.chain().focus().toggleBlockquote().run()}>❝</FBtn>
      <FBtn editor={editor} active={editor.isActive('codeBlock')} title="Code block" onClick={() => editor.chain().focus().setCodeBlock().run()}>&lt;/&gt;▾</FBtn>
      <FBtn editor={editor} active={false} title="Divider" onClick={() => editor.chain().focus().insertContent({ type: 'horizontalRule' }).run()}>—</FBtn>
    </div>
  );
}
