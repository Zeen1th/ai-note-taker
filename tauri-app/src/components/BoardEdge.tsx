import { useMemo } from 'react';
import type { BoardEdge as EdgeType, BoardNode as NodeType } from '../lib/types';

interface Props {
  edge: EdgeType;
  nodes: NodeType[];
  onDelete: (id: string) => void;
}

function anchorPoint(n: NodeType, side: string): { x: number; y: number } {
  switch (side) {
    case 'top': return { x: n.x + n.w / 2, y: n.y };
    case 'right': return { x: n.x + n.w, y: n.y + n.h / 2 };
    case 'bottom': return { x: n.x + n.w / 2, y: n.y + n.h };
    case 'left': return { x: n.x, y: n.y + n.h / 2 };
    default: return { x: n.x + n.w / 2, y: n.y + n.h / 2 };
  }
}

function bestAnchorPair(a: NodeType, b: NodeType): { pa: { x: number; y: number }; pb: { x: number; y: number } } {
  const sides = ['top', 'right', 'bottom', 'left'];
  let best: { pa: { x: number; y: number }; pb: { x: number; y: number } } | null = null;
  let bestD = Infinity;
  for (const sa of sides) {
    for (const sb of sides) {
      const pa = anchorPoint(a, sa);
      const pb = anchorPoint(b, sb);
      const d = (pa.x - pb.x) ** 2 + (pa.y - pb.y) ** 2;
      if (d < bestD) { bestD = d; best = { pa, pb }; }
    }
  }
  return best!;
}

function bezierPath(pa: { x: number; y: number }, pb: { x: number; y: number }): string {
  const dx = Math.abs(pb.x - pa.x);
  const dy = Math.abs(pb.y - pa.y);
  const off = Math.max(40, Math.min(160, (dx + dy) / 3));
  let c1x = pa.x, c1y = pa.y, c2x = pb.x, c2y = pb.y;
  if (dx > dy) {
    c1x += (pb.x > pa.x ? off : -off);
    c2x -= (pb.x > pa.x ? off : -off);
  } else {
    c1y += (pb.y > pa.y ? off : -off);
    c2y -= (pb.y > pa.y ? off : -off);
  }
  return `M${pa.x},${pa.y} C${c1x},${c1y} ${c2x},${c2y} ${pb.x},${pb.y}`;
}

function arrowHead(pb: { x: number; y: number }, pa: { x: number; y: number }): string {
  const ang = Math.atan2(pb.y - pa.y, pb.x - pa.x);
  const len = 8;
  return `${pb.x},${pb.y} ${pb.x - len * Math.cos(ang - 0.4)},${pb.y - len * Math.sin(ang - 0.4)} ${pb.x - len * Math.cos(ang + 0.4)},${pb.y - len * Math.sin(ang + 0.4)}`;
}

export function BoardEdge({ edge, nodes, onDelete }: Props) {
  const { d, headPoints, midX, midY } = useMemo(() => {
    const a = nodes.find((n) => n.id === edge.fromId);
    const b = nodes.find((n) => n.id === edge.toId);
    if (!a || !b) return { d: '', headPoints: '', midX: 0, midY: 0 };
    const pair = bestAnchorPair(a, b);
    return {
      d: bezierPath(pair.pa, pair.pb),
      headPoints: arrowHead(pair.pb, pair.pa),
      midX: (pair.pa.x + pair.pb.x) / 2,
      midY: (pair.pa.y + pair.pb.y) / 2,
    };
  }, [edge, nodes]);

  if (!d) return null;

  const stroke = edge.color ? `var(--sp${edge.color})` : 'var(--muted)';

  return (
    <g>
      {/* invisible fat hit area */}
      <path d={d} className="edge-hit" onClick={(e) => { e.stopPropagation(); onDelete(edge.id); }} />
      {/* visible path */}
      <path d={d} className="edge-path" style={{ stroke }} />
      {/* arrowhead */}
      <polygon points={headPoints} fill={stroke} style={{ pointerEvents: 'none' }} />
      {/* label */}
      {edge.label && (
        <text x={midX} y={midY - 4} textAnchor="middle" className="edge-label" style={{ pointerEvents: 'none' }}>
          {edge.label}
        </text>
      )}
    </g>
  );
}
