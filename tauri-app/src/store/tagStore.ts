import { create } from 'zustand';
import { listTags, setTagColor, deleteTagColor } from '../lib/tauri';
import type { TagInfo } from '../lib/types';

interface TagStore {
  tags: TagInfo[];
  loaded: boolean;
  refresh: () => Promise<void>;
  setColor: (name: string, color: number) => Promise<void>;
  resetColor: (name: string) => Promise<void>;
}

// Distinct 10-color palette, readable on both light and dark themes.
export const TAG_COLORS = [
  '#ef4444', // red
  '#f97316', // orange
  '#eab308', // yellow
  '#84cc16', // lime
  '#22c55e', // green
  '#14b8a6', // teal
  '#06b6d4', // cyan
  '#3b82f6', // blue
  '#8b5cf6', // violet
  '#ec4899', // pink
];

// Deterministic default color index for tags without a stored one (1..10).
function hashColor(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return (h % TAG_COLORS.length) + 1;
}

export function tagColor(tag: TagInfo | { name: string; color?: number }): number {
  const c = (tag as TagInfo).color ?? 0;
  if (c < 1 || c > TAG_COLORS.length) return hashColor(tag.name);
  return c;
}

// Pick a readable text color for a filled chip of the given hex background.
export function tagTextColor(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.62 ? 'rgba(18, 20, 26, 0.88)' : '#fff';
}

// Background + text color for a fully colored tag chip.
export function tagChipStyle(tag: TagInfo | { name: string; color?: number }) {
  const hex = TAG_COLORS[tagColor(tag) - 1];
  return { background: hex, color: tagTextColor(hex) };
}

export const useTagStore = create<TagStore>((set) => ({
  tags: [],
  loaded: false,

  refresh: async () => {
    try {
      const tags = await listTags();
      set({ tags, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },

  setColor: async (name, color) => {
    await setTagColor(name, color);
    set((s) => ({ tags: s.tags.map((t) => (t.name === name ? { ...t, color } : t)) }));
  },

  resetColor: async (name) => {
    await deleteTagColor(name);
    set((s) => ({ tags: s.tags.map((t) => (t.name === name ? { ...t, color: 0 } : t)) }));
  },
}));
