// Build an AI-oriented Markdown document from a whole board: every card in a
// stable, self-describing order (notes → images → containers → groups), with
// tags, container nesting and edges as explicit relationships.
import type { BoardEdge, BoardNode } from './types';
import { docToMarkdown, htmlToText } from './editor/markdown';

export function nodeTitle(n: BoardNode): string {
  if ((n.customTitle ?? '').trim()) return (n.customTitle ?? '').trim();
  if (n.kind === 'reference') return 'Reference';
  const first = (n.text || '').split('\n').find((l) => l.trim());
  return (first ? htmlToText(first) : '').slice(0, 60) || 'Untitled note';
}

function nodeBody(n: BoardNode): string {
  if (n.blocks) {
    try {
      const md = docToMarkdown(JSON.parse(n.blocks));
      if (md.trim()) return md.trim();
    } catch {
      /* fall through to plain text */
    }
  }
  return htmlToText(n.text || '').trim();
}

function tagsOf(n: BoardNode): string {
  return (n.tags ?? []).map((t) => `\`#${t}\``).join(' ');
}

const KIND_LABEL: Record<BoardNode['kind'], string> = {
  note: 'note',
  reference: 'image',
  node: 'container',
  group: 'group',
};

function childLine(n: BoardNode): string {
  return `- **${nodeTitle(n)}** (${KIND_LABEL[n.kind]})${tagsOf(n) ? ' ' + tagsOf(n) : ''}`;
}

function listChildren(container: BoardNode, all: BoardNode[], depth: number, out: string[]): void {
  all.filter((n) => n.parentId === container.id).forEach((child) => {
    out.push(childLine(child));
    if (child.kind === 'node') listChildren(child, all, depth + 1, out);
  });
}

/** Serialize a board (name + cards + edges) into an AI-friendly Markdown doc. */
export function buildBoardMarkdown(boardName: string, nodes: BoardNode[], edges: BoardEdge[]): string {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const roots = nodes.filter((n) => !(n.parentId && byId.has(n.parentId)));

  const notes = roots.filter((n) => n.kind === 'note');
  const references = roots.filter((n) => n.kind === 'reference');
  const containers = roots.filter((n) => n.kind === 'node');
  const groups = roots.filter((n) => n.kind === 'group');

  const parts: string[] = [];
  parts.push(`# Board: ${boardName}`);
  parts.push('');
  parts.push(
    `> Exported ${new Date().toLocaleString()} — ${nodes.length} cards, ${edges.length} relationships.`,
  );
  parts.push('');

  if (notes.length) {
    parts.push('## Notes');
    for (const n of notes) {
      parts.push(`### ${nodeTitle(n)}${tagsOf(n) ? ' — ' + tagsOf(n) : ''}`);
      parts.push('');
      parts.push(nodeBody(n) || '*(empty)*');
      parts.push('');
    }
  }

  if (references.length) {
    parts.push('## Image references (whole images)');
    for (const n of references) {
      parts.push(`### ${nodeTitle(n)}${tagsOf(n) ? ' — ' + tagsOf(n) : ''}`);
      parts.push('');
      const id = n.image || 'unknown';
      parts.push(`![${nodeTitle(n)}](boardimg://localhost/${id})`);
      parts.push('');
      parts.push(`> Whole image attached — image id \`${id}\` (open the app to view it).`);
      parts.push('');
    }
  }

  if (containers.length) {
    parts.push('## Containers (folders)');
    for (const c of containers) {
      parts.push(`### ${nodeTitle(c)}${tagsOf(c) ? ' — ' + tagsOf(c) : ''}`);
      parts.push('');
      const children: string[] = [];
      listChildren(c, nodes, 1, children);
      if (children.length) parts.push(...children);
      else parts.push('*(empty container)*');
      parts.push('');
    }
  }

  if (groups.length) {
    parts.push('## Groups (layout zones)');
    for (const g of groups) {
      parts.push(`### ${nodeTitle(g)}${tagsOf(g) ? ' — ' + tagsOf(g) : ''}`);
      parts.push('');
    }
  }

  if (edges.length) {
    parts.push('## Relationships');
    for (const e of edges) {
      const from = byId.get(e.fromId);
      const to = byId.get(e.toId);
      const fromT = from ? nodeTitle(from) : '(deleted card)';
      const toT = to ? nodeTitle(to) : '(deleted card)';
      const arrow = e.label?.trim() ? ` — *${e.label.trim()}* —> ` : ' —> ';
      parts.push(`- **${fromT}**${arrow}**${toT}**`);
    }
    parts.push('');
  }

  if (nodes.length === 0) parts.push('*(board is empty)*');

  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
