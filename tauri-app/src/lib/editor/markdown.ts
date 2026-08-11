// Convert a TipTap JSON document (block tree) into standard Markdown.
// Nodes are plain JSON objects (type / text / attrs / marks / content),
// so this utility has zero runtime dependencies.

export interface MDMark { type: string; attrs?: Record<string, any>; }
export interface MDNode {
  type?: string;
  text?: string;
  attrs?: Record<string, any>;
  marks?: MDMark[];
  content?: MDNode[];
}

function escapeInline(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/([*_`[\]])/g, '\\$1');
}

function escapeLineStart(text: string): string {
  return text.replace(/^([#>\-+=\d.])/, '\\$1');
}

function inlineText(node: MDNode): string {
  const raw = node.text ?? '';
  const text = escapeInline(raw);
  const marks = node.marks ?? [];
  const out = marks.reduce((acc, m) => {
    switch (m.type) {
      case 'bold': return `**${acc}**`;
      case 'italic': return `*${acc}*`;
      case 'strike': return `~~${acc}~~`;
      case 'code': return `\`${acc}\``;
      case 'link': {
        const href = (m.attrs as any)?.href ?? '';
        return `[${acc}](${href})`;
      }
      case 'internalLink':
        // wiki-style: renders as [[label]] so exported markdown keeps the
        // link target readable for humans and AI alike
        return `[[${acc}]]`;
      case 'highlight': return `==${acc}==`;
      case 'underline': return acc;
      default: return acc;
    }
  }, text);
  return out;
}

function inline(node: MDNode): string {
  if (node.type === 'text') return inlineText(node);
  if (node.type === 'image') {
    const src = (node.attrs as any)?.src ?? '';
    const alt = (node.attrs as any)?.alt ?? '';
    return `![${alt}](${src})`;
  }
  if (node.type === 'hardBreak') return '\n';
  return (node.content ?? []).map(inline).join('');
}

function block(node: MDNode, depth: number, _orderedListIndex: number): string {
  const indent = '  '.repeat(depth);
  const children = node.content ?? [];

  switch (node.type) {
    case 'paragraph':
      return indent + escapeLineStart(inline(node));
    case 'heading': {
      const level = Math.min(6, Math.max(1, (node.attrs as any)?.level ?? 1));
      return indent + '#'.repeat(level) + ' ' + escapeLineStart(inline(node));
    }
    case 'blockquote':
      return children.map((c) => {
        const inner = block(c, 0, 0).split('\n').map((l) => `> ${l}`).join('\n');
        return indent + inner;
      }).join('\n\n');
    case 'bulletList':
      return children
        .map((li) => {
          const content = (li.content ?? [])
            .filter((c) => c.type !== 'bulletList' && c.type !== 'orderedList' && c.type !== 'taskList')
            .map((c) => block(c, 0, 0)).join('\n')
            .split('\n').map((l) => indent + '- ' + l).join('\n');
          const nested = (li.content ?? [])
            .filter((c) => ['bulletList', 'orderedList', 'taskList'].includes(c.type!))
            .map((c) => block(c, depth + 1, 0)).join('\n');
          return nested ? content + '\n' + nested : content;
        })
        .join('\n');
    case 'orderedList':
      return children
        .map((li, i) => {
          const content = (li.content ?? [])
            .filter((c) => c.type !== 'bulletList' && c.type !== 'orderedList' && c.type !== 'taskList')
            .map((c) => block(c, 0, 0)).join('\n')
            .split('\n').map((l) => indent + `${i + 1}. ` + l).join('\n');
          const nested = (li.content ?? [])
            .filter((c) => ['bulletList', 'orderedList', 'taskList'].includes(c.type!))
            .map((c) => block(c, depth + 1, 0)).join('\n');
          return nested ? content + '\n' + nested : content;
        })
        .join('\n');
    case 'taskList':
      return children.map((li) => {
        const checked = (li.attrs as any)?.checked ? '[x]' : '[ ]';
        const content = (li.content ?? [])
          .filter((c) => c.type !== 'taskList')
          .map((c) => block(c, 0, 0)).join('\n')
          .split('\n').map((l) => indent + `- ${checked} ` + l).join('\n');
        const nested = (li.content ?? [])
          .filter((c) => c.type === 'taskList')
          .map((c) => block(c, depth + 1, 0)).join('\n');
        return nested ? content + '\n' + nested : content;
      }).join('\n');
    case 'codeBlock': {
      const lang = (node.attrs as any)?.language ?? '';
      const code = (node.text ?? '').replace(/\n$/, '');
      return indent + '```' + lang + '\n' + code + '\n' + indent + '```';
    }
    case 'horizontalRule':
      return indent + '---';
    default:
      return (node.content ?? []).map((c) => block(c, depth, 0)).join('\n\n');
  }
}

/** Serialize a TipTap JSON document into Markdown text. */
export function docToMarkdown(doc: MDNode): string {
  const body = (doc.content ?? []).map((c) => block(c, 0, 0)).join('\n\n');
  return body.replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/** Convert an HTML string to plain text (board nodes store HTML in `text`). */
export function htmlToText(html: string): string {
  if (!/<[a-z][\s\S]*>/i.test(html)) return html;
  try {
    const el = document.createElement('div');
    el.innerHTML = html;
    return el.textContent || '';
  } catch {
    return html.replace(/<[^>]+>/g, ' ');
  }
}
