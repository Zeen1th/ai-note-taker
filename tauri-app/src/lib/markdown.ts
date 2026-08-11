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
  kind: 'note';
  image: string;
  tag?: string;
}

// Heading → tag slug: "Action Items" → "action-items", "Summary" → "summary".
function slugTag(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// ---- Content-based sizing for spawned board notes -------------------------
// The board note body renders at 1.34rem / line-height 1.75 (~38px per line)
// with 22px side padding; the node head (color bar + title row) is ~74px.
// Estimates are generous on purpose — a slightly taller note beats clipped text.
const NODE_W = 260;
const CHAR_W = 11.5;  // avg px per char at the 1.34rem body font
const BODY_LH = 38;
const HEADING_LH = 62; // h2 line + margins
const CODE_LH = 30;
const HEAD_H = 76;
const BODY_PAD = 42;

function wrapLines(text: string, charsPerLine: number): number {
  if (!text) return 1;
  return Math.max(1, Math.ceil(text.length / charsPerLine));
}

// Height needed to show `md` (markdown) as a board note of width `w`.
export function estimateNodeHeight(md: string, w: number = NODE_W): number {
  const inner = Math.max(120, w - 46);
  const perLine = Math.max(10, Math.floor(inner / CHAR_W));
  let h = 0;
  let inCode = false;
  for (const raw of md.split('\n')) {
    const t = raw.trim();
    if (/^```/.test(t)) { inCode = !inCode; continue; }
    if (!t) { h += 10; continue; }
    if (inCode) { h += CODE_LH; continue; }
    if (/^#{1,3}\s/.test(t)) { h += HEADING_LH; continue; }
    const isList = /^[-*+]\s/.test(t) || /^\d+[.)]\s/.test(t);
    const isQuote = /^>\s?/.test(t);
    const clean = t.replace(/^[-*+]\s*/, '').replace(/^\d+[.)]\s*/, '').replace(/^>\s*/, '');
    const cpl = isList ? Math.max(8, perLine - 3) : perLine;
    h += wrapLines(clean, cpl) * BODY_LH + (isList ? 4 : isQuote ? 12 : 9);
  }
  return Math.max(150, Math.round(HEAD_H + h + BODY_PAD));
}

// Split AI notes (markdown) into one node per top-level section — mirrors the
// old backend's _notes_to_nodes(): Summary / Key Points / Decisions / Action
// Items each become their own node in a gentle cascade. The section text is
// converted to real HTML (headings, lists, quotes) so TipTap renders it
// properly, and each node is sized to fit its content.
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
  let rowY = 80;
  let rowH = 0;
  sections.forEach((text, idx) => {
    if (!text.trim()) return;
    const heading = headings[idx];
    const col = idx % 4;
    if (col === 0 && idx > 0) { rowY += rowH + 40; rowH = 0; }
    const h = estimateNodeHeight(text);
    rowH = Math.max(rowH, h);
    nodes.push({
      x: 80 + col * (NODE_W + 20),
      y: rowY,
      w: NODE_W,
      h,
      text: renderMarkdown(text),
      c: idx % 5,
      kind: 'note',
      image: '',
      tag: heading ? slugTag(heading.replace(/^#{1,2}\s+/, '')) : undefined,
    });
  });
  return nodes;
}
