// Mini Markdown renderer — covers the AI output (headings, bold, lists, quotes).
// Deliberately tiny; the old app used marked via CDN, this mirrors its output.

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inline(text: string): string {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

export function renderMarkdown(md: string): string {
  if (!md) return '';
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let list: string[] | null = null;
  let listTag = 'ul';
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join(' '))}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      out.push(`<${listTag}>${list.map((li) => `<li>${inline(li)}</li>`).join('')}</${listTag}>`);
      list = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const bullet = /^[-*+]\s+(.*)$/.exec(line);
    const ordered = /^\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || ordered) {
      flushPara();
      const tag = bullet ? 'ul' : 'ol';
      if (list && listTag !== tag) flushList();
      if (!list) listTag = tag;
      list = list || [];
      list.push(esc(bullet ? bullet[1] : ordered![1]));
      continue;
    }
    flushList();
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(esc(heading[2]))}</h${level}>`);
      continue;
    }
    if (/^\s*>/.test(line)) {
      flushPara();
      out.push(`<blockquote>${inline(esc(line.replace(/^\s*>\s?/, '')))}</blockquote>`);
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flushPara();
      out.push('<hr>');
      continue;
    }
    if (line.trim() === '') {
      flushPara();
      continue;
    }
    para.push(esc(line));
  }
  flushList();
  flushPara();
  return out.join('\n');
}

export interface DraftNode {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  c: number;
  kind: string;
  image: string;
}

// Split AI notes (markdown) into one node per top-level section — mirrors the
// old backend's _notes_to_nodes(): Summary / Key Points / Decisions / Action
// Items each become their own node in a gentle cascade.
export function notesToNodes(notesMarkdown: string): DraftNode[] {
  if (!notesMarkdown || !notesMarkdown.trim()) return [];
  const parts = notesMarkdown.split(/^#{1,2}\s+.*$/m);
  const headings = notesMarkdown.match(/^#{1,2}\s+.*$/gm) || [];
  const sections: string[] = [];
  if (parts[0]?.trim()) sections.push(parts[0].trim());
  for (let i = 0; i < headings.length; i++) {
    const body = (parts[i + 1] || '').trim();
    sections.push(body ? `${headings[i]}\n${body}` : headings[i]);
  }
  const nodes: DraftNode[] = [];
  sections.forEach((text, idx) => {
    if (!text.trim()) return;
    nodes.push({
      x: 80 + (idx % 4) * 280,
      y: 80 + Math.floor(idx / 4) * 200,
      w: 260,
      h: 160,
      text,
      c: idx % 5,
      kind: 'note',
      image: '',
    });
  });
  return nodes;
}
