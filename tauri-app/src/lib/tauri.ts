import { invoke } from '@tauri-apps/api/core';
import type { Board, BoardNode, BoardEdge, BoardResponse } from './types';

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
