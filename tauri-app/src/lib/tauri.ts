import { invoke } from '@tauri-apps/api/core';
import type { Board, BoardNode, BoardEdge, BoardResponse, TagInfo, TrashEntry } from './types';

export async function listBoards(): Promise<Board[]> {
  return invoke<Board[]>('list_boards');
}

export async function createBoard(name: string, sourceSessionId = ''): Promise<Board> {
  return invoke<Board>('create_board', { req: { name, sourceSessionId } });
}

export async function getBoard(boardId: string): Promise<BoardResponse> {
  return invoke<BoardResponse>('get_board', { boardId });
}

export async function putBoard(boardId: string, nodes: BoardNode[], edges: Partial<BoardEdge>[]): Promise<{ 0: BoardNode[]; 1: BoardEdge[] }> {
  // Rust returns a tuple (Vec<Node>, Vec<Edge>) — Tauri serializes as [nodes, edges]
  return invoke('put_board', { boardId, req: { nodes, edges } });
}

export async function deleteBoard(boardId: string): Promise<boolean> {
  return invoke<boolean>('delete_board_cmd', { boardId });
}

export async function renameBoard(boardId: string, name: string): Promise<boolean> {
  return invoke<boolean>('rename_board_cmd', { boardId, req: { name } });
}

// Window controls
import { getCurrentWindow } from '@tauri-apps/api/window';

export async function minimizeWindow() {
  await getCurrentWindow().minimize();
}

export async function toggleMaximize() {
  const win = getCurrentWindow();
  if (await win.isMaximized()) {
    await win.unmaximize();
  } else {
    await win.maximize();
  }
}

export async function closeWindow() {
  await getCurrentWindow().close();
}

// AI sidecar — returns the base URL (spawns the Python server if not running)
export async function getSidecarUrl(): Promise<string> {
  return invoke<string>('get_sidecar_url');
}

// Board images — saved to data/board_images, served via the boardimg:// protocol
export async function saveBoardImage(bytes: Uint8Array, ext: string): Promise<{ id: string; url: string; ext: string }> {
  return invoke('save_board_image', { bytes, ext });
}

// Ingest an image dropped from the OS (path based)
export async function saveBoardImageFromPath(path: string): Promise<{ id: string }> {
  return invoke('save_board_image_from_path', { path });
}

// Tags — global across all boards
export async function listTags(): Promise<TagInfo[]> {
  return invoke<TagInfo[]>('list_tags');
}

export async function setTagColor(name: string, color: number): Promise<void> {
  return invoke('set_tag_color', { req: { name, color } });
}

export async function deleteTagColor(name: string): Promise<void> {
  return invoke('delete_tag_color', { req: { name } });
}

// Trash — deleted notes history
export async function listTrash(): Promise<TrashEntry[]> {
  return invoke<TrashEntry[]>('list_trash');
}

export async function saveToTrash(boardId: string, node: BoardNode): Promise<void> {
  return invoke('save_to_trash', { req: { boardId, cardId: node.id, data: JSON.stringify(node) } });
}

export async function restoreTrash(id: number): Promise<BoardNode> {
  return invoke<BoardNode>('restore_trash', { id });
}

export async function deleteTrashEntry(id: number): Promise<void> {
  return invoke('delete_trash_entry', { id });
}

export async function syncTrash(): Promise<void> {
  return invoke('sync_trash');
}

// Board export — writes an AI-friendly Markdown file to the user's Documents
// folder ("note-taker exports/") and reveals it in Explorer. Returns the path.
export async function saveMarkdownExport(filename: string, content: string): Promise<string> {
  return invoke<string>('save_markdown_export', { filename, content });
}
