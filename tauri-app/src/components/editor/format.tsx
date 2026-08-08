// Shared formatting UI: the floating bubble bar (text selection) and the
// static toolbar shown under the note title. Both bind to any TipTap editor.
import type { Editor } from '@tiptap/react';
import { showPrompt } from '../../lib/dialogs';

export const TEXT_COLORS = ['#e5484d', '#f76b15', '#46a758', '#3e63dd', '#8e4ec6', '#6e56cf', '#64748b'];
export const HIGHLIGHTS = ['#fff3bf', '#c5f8cf', '#d0ebff', '#ffe3ec', '#ffe5cc'];

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

export function BubbleFormatBar({ editor }: { editor: Editor }) {
  return (
    <div className="bubble-menu">
      <FBtn editor={editor} active={editor.isActive('bold')} title="Bold (Ctrl+B)" onClick={() => editor.chain().focus().toggleBold().run()}><b>B</b></FBtn>
      <FBtn editor={editor} active={editor.isActive('italic')} title="Italic (Ctrl+I)" onClick={() => editor.chain().focus().toggleItalic().run()}><i>I</i></FBtn>
      <FBtn editor={editor} active={editor.isActive('underline')} title="Underline (Ctrl+U)" onClick={() => editor.chain().focus().toggleUnderline().run()}><u>U</u></FBtn>
      <FBtn editor={editor} active={editor.isActive('strike')} title="Strikethrough" onClick={() => editor.chain().focus().toggleStrike().run()}><s>S</s></FBtn>
      <FBtn editor={editor} active={editor.isActive('code')} title="Inline code" onClick={() => editor.chain().focus().toggleCode().run()}>&lt;/&gt;</FBtn>
      <FBtn editor={editor} active={editor.isActive('link')} title="Add link" onClick={() => insertLink(editor)}>
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

export function StaticToolbar({ editor }: { editor: Editor }) {
  return (
    <div className="rich-toolbar">
      <FBtn editor={editor} active={editor.isActive('paragraph')} title="Paragraph" onClick={() => editor.chain().focus().setParagraph().run()}>¶</FBtn>
      <FBtn editor={editor} active={editor.isActive('heading', { level: 1 })} title="Heading 1" onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}>H1</FBtn>
      <FBtn editor={editor} active={editor.isActive('heading', { level: 2 })} title="Heading 2" onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>H2</FBtn>
      <FBtn editor={editor} active={editor.isActive('heading', { level: 3 })} title="Heading 3" onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}>H3</FBtn>
      <span className="bubble-sep" />
      <FBtn editor={editor} active={editor.isActive('bold')} title="Bold (Ctrl+B)" onClick={() => editor.chain().focus().toggleBold().run()}><b>B</b></FBtn>
      <FBtn editor={editor} active={editor.isActive('italic')} title="Italic (Ctrl+I)" onClick={() => editor.chain().focus().toggleItalic().run()}><i>I</i></FBtn>
      <FBtn editor={editor} active={editor.isActive('underline')} title="Underline (Ctrl+U)" onClick={() => editor.chain().focus().toggleUnderline().run()}><u>U</u></FBtn>
      <FBtn editor={editor} active={editor.isActive('strike')} title="Strikethrough" onClick={() => editor.chain().focus().toggleStrike().run()}><s>S</s></FBtn>
      <FBtn editor={editor} active={editor.isActive('code')} title="Inline code" onClick={() => editor.chain().focus().toggleCode().run()}>&lt;/&gt;</FBtn>
      <FBtn editor={editor} active={editor.isActive('link')} title="Add link" onClick={() => insertLink(editor)}>
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
