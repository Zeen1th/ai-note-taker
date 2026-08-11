import { useState, useCallback } from 'react';
import { useEditor, EditorContent, BubbleMenu } from '@tiptap/react';
import { editorExtensions } from '../../lib/editor/extensions';
import { useSlashMenu, SlashMenuView } from './slashMenu';
import { useTagMenu, TagMenuView } from './tagMenu';
import { BubbleFormatBar, StaticToolbar, type LinkTargetItem } from './format';
import { toast } from '../../lib/toast';

export type { LinkTargetItem } from './format';

interface Props {
  blocks?: string | null;
  html?: string;
  placeholder?: string;
  autofocus?: boolean;
  toolbar?: boolean;
  linkTargets?: LinkTargetItem[];
  onTagSelect?: (tag: string) => void;
  onChange: (json: object, html: string) => void;
}

export function RichEditor({ blocks, html, placeholder, autofocus, toolbar, linkTargets, onTagSelect, onChange }: Props) {
  const [codeActive, setCodeActive] = useState(false);

  const editor = useEditor({
    extensions: editorExtensions(placeholder || "Type '/' for commands, or start writing…"),
    content: '',
    editorProps: { attributes: { dir: 'auto' } },
    onUpdate: ({ editor: ed }) => onChange(ed.getJSON(), ed.getHTML()),
    onSelectionUpdate: ({ editor: ed }) => setCodeActive(ed.isActive('codeBlock')),
    onCreate: ({ editor: ed }) => {
      if (blocks) {
        try { ed.commands.setContent(JSON.parse(blocks)); } catch { ed.commands.setContent(html || ''); }
      } else if (html) {
        ed.commands.setContent(html, false);
      }
      if (autofocus) ed.commands.focus('start');
    },
  });

  const { slash, items, slashIdx, runItem, setSlashIdx } = useSlashMenu(editor);

  const { tagMenu, tagItems, tagIdx, pickTag, setTagIdx } = useTagMenu(
    editor,
    (tag) => onTagSelect?.(tag),
  );

  const copyCode = useCallback(() => {
    if (!editor) return;
    const node = editor.state.selection.$from.parent;
    if (node.type.name === 'codeBlock') {
      navigator.clipboard.writeText(node.textContent).then(() => toast('Code copied.'));
    }
  }, [editor]);

  return (
    <div className="rich-editor">
      {editor && toolbar && <StaticToolbar editor={editor} linkTargets={linkTargets} />}
      {editor && (
        <>
          <EditorContent editor={editor} />

          {codeActive && (
            <button className="code-copy-btn" onClick={copyCode} title="Copy code">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>
              Copy
            </button>
          )}

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

          {tagMenu && onTagSelect && (
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
