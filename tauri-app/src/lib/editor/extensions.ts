// Shared TipTap extension set — used by the focus-mode RichEditor and by the
// inline board-node editors so both behave identically.
import StarterKit from '@tiptap/starter-kit';
import { Extension, Mark } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Link from '@tiptap/extension-link';
import TextStyle from '@tiptap/extension-text-style';
import Color from '@tiptap/extension-color';
import Highlight from '@tiptap/extension-highlight';
import Underline from '@tiptap/extension-underline';
import Placeholder from '@tiptap/extension-placeholder';
import TextAlign from '@tiptap/extension-text-align';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { createLowlight, common } from 'lowlight';

const lowlight = createLowlight(common);

// Per-selection font size, stored as a TextStyle mark. em keeps the size
// relative to the editor's base font (board node vs modal differ).
const FontSize = Extension.create({
  name: 'fontSize',
  addGlobalAttributes() {
    return [
      {
        types: ['textStyle'],
        attributes: {
          fontSize: {
            default: null,
            parseHTML: (el) => el.style.fontSize || null,
            renderHTML: (attrs) => (attrs.fontSize ? { style: `font-size: ${attrs.fontSize}` } : {}),
          },
        },
      },
    ];
  },
  addCommands() {
    return {
      setFontSize:
        (size: string | null) =>
        ({ chain }) =>
          chain().setMark('textStyle', { fontSize: size ?? null }).removeEmptyTextStyle().run(),
    };
  },
});

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    fontSize: { setFontSize: (size: string | null) => ReturnType };
    fontFamily: { setFontFamily: (family: string | null) => ReturnType };
    internalLink: {
      setInternalLink: (type: InternalLinkTarget['type'], id: string) => ReturnType;
      unsetInternalLink: () => ReturnType;
    };
  }
}

// ---- Internal links: text that points to another note / image / node / group ----
export type InternalLinkTarget = { type: 'note' | 'reference' | 'node' | 'group'; id: string };
type InternalLinkHandler = (target: InternalLinkTarget) => void;
let internalLinkHandler: InternalLinkHandler | null = null;

// App registers its navigator here; the editor just forwards clicks.
export function setInternalLinkHandler(fn: InternalLinkHandler | null) {
  internalLinkHandler = fn;
}

const InternalLink = Mark.create({
  name: 'internalLink',
  inclusive: true,
  addAttributes() {
    return {
      type: {
        default: 'note',
        parseHTML: (el) => el.getAttribute('data-link-type') || 'note',
        renderHTML: (attrs) => ({ 'data-link-type': attrs.type }),
      },
      id: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-link-id') || '',
        renderHTML: (attrs) => (attrs.id ? { 'data-link-id': attrs.id } : {}),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'a[data-internal-link]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['a', { ...HTMLAttributes, href: '#', class: 'internal-link', 'data-internal-link': '1' }, 0];
  },
  addCommands() {
    return {
      setInternalLink:
        (type: InternalLinkTarget['type'], id: string) =>
        ({ commands }) =>
          commands.setMark(this.name, { type, id }),
      unsetInternalLink:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('internalLinkClick'),
        props: {
          handleClick(_view, _pos, event) {
            const el = (event.target as HTMLElement)?.closest?.('a[data-internal-link]');
            if (!el) return false;
            event.preventDefault();
            const type = (el.getAttribute('data-link-type') || 'note') as InternalLinkTarget['type'];
            const id = el.getAttribute('data-link-id') || '';
            if (id) internalLinkHandler?.({ type, id });
            return true;
          },
        },
      }),
    ];
  },
});

// Per-selection font family, stored as a TextStyle mark.
const FontFamily = Extension.create({
  name: 'fontFamily',
  addGlobalAttributes() {
    return [
      {
        types: ['textStyle'],
        attributes: {
          fontFamily: {
            default: null,
            parseHTML: (el) => el.style.fontFamily || null,
            renderHTML: (attrs) => (attrs.fontFamily ? { style: `font-family: ${attrs.fontFamily}` } : {}),
          },
        },
      },
    ];
  },
  addCommands() {
    return {
      setFontFamily:
        (family: string | null) =>
        ({ chain }) =>
          chain().setMark('textStyle', { fontFamily: family ?? null }).removeEmptyTextStyle().run(),
    };
  },
});

export function editorExtensions(placeholder: string) {
  return [
    StarterKit.configure({ heading: { levels: [1, 2, 3] }, codeBlock: false }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Link.configure({ openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' } }),
    Underline,
    TextStyle,
    Color,
    Highlight.configure({ multicolor: true }),
    Placeholder.configure({ placeholder }),
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    CodeBlockLowlight.configure({ lowlight, defaultLanguage: 'plaintext' }),
    FontSize,
    FontFamily,
    InternalLink,
  ];
}
