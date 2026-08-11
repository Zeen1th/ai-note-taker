use crate::db::{self, Board, BoardNode, BoardEdge, TagInfo, TrashEntry};
use crate::AppState;
use serde::{Deserialize, Serialize};
use tauri::State;

// ---------------------------------------------------------------------------
// Request types
// ---------------------------------------------------------------------------
#[derive(Deserialize)]
pub struct CreateBoardReq {
    pub name: Option<String>,
    #[serde(rename = "sourceSessionId")]
    pub source_session_id: Option<String>,
}

#[derive(Deserialize)]
pub struct RenameBoardReq {
    pub name: String,
}

#[derive(Deserialize)]
pub struct PutBoardReq {
    pub nodes: Vec<BoardNode>,
    pub edges: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
pub struct TagColorReq {
    pub name: String,
    pub color: i64,
}

#[derive(Deserialize)]
pub struct TagNameReq {
    pub name: String,
}

#[derive(Deserialize)]
pub struct SaveTrashReq {
    #[serde(rename = "boardId")]
    pub board_id: String,
    #[serde(rename = "cardId")]
    pub card_id: String,
    pub data: String,
}

// ---------------------------------------------------------------------------
// Response wrappers
// ---------------------------------------------------------------------------
#[derive(Serialize)]
pub struct BoardResponse {
    pub board: serde_json::Value,
    pub nodes: Vec<BoardNode>,
    pub edges: Vec<BoardEdge>,
}

// ---------------------------------------------------------------------------
// Helper: get a connection from the state
// ---------------------------------------------------------------------------
fn with_conn<F, R>(state: &State<AppState>, f: F) -> Result<R, String>
where
    F: FnOnce(&rusqlite::Connection) -> R,
{
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    Ok(f(&conn))
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
#[tauri::command]
pub fn list_boards(state: State<AppState>) -> Result<Vec<Board>, String> {
    with_conn(&state, |conn| db::list_boards(conn))
}

#[tauri::command]
pub fn create_board(req: CreateBoardReq, state: State<AppState>) -> Result<Board, String> {
    with_conn(&state, |conn| {
        db::create_board(
            conn,
            req.name.as_deref().unwrap_or(""),
            req.source_session_id.as_deref().unwrap_or(""),
        )
    })
}

#[tauri::command]
pub fn get_board(board_id: String, state: State<AppState>) -> Result<BoardResponse, String> {
    with_conn(&state, |conn| {
        let bid = if db::get_board_nodes(conn, &board_id).is_empty()
            && db::first_board_id(conn).as_deref() != Some(&board_id)
        {
            db::first_board_id(conn).unwrap_or_default()
        } else {
            board_id.clone()
        };
        let nodes = db::get_board_nodes(conn, &bid);
        let edges = db::get_board_edges(conn, &bid);

        // get board metadata
        let board = conn
            .query_row(
                "SELECT id, name, source_session_id, created_at, updated_at FROM boards WHERE id = ?1",
                [&bid],
                |row| {
                    Ok(serde_json::json!({
                        "id": row.get::<_, String>(0)?,
                        "name": row.get::<_, String>(1)?,
                        "sourceSessionId": row.get::<_, Option<String>>(2)?,
                        "createdAt": row.get::<_, String>(3)?,
                        "updatedAt": row.get::<_, String>(4)?,
                    }))
                },
            )
            .unwrap_or(serde_json::json!({}));

        BoardResponse { board, nodes, edges }
    })
}

#[tauri::command]
pub fn put_board(
    board_id: String,
    req: PutBoardReq,
    state: State<AppState>,
) -> Result<(Vec<BoardNode>, Vec<BoardEdge>), String> {
    with_conn(&state, |conn| {
        db::replace_board(conn, &board_id, &req.nodes, &req.edges);
        let nodes = db::get_board_nodes(conn, &board_id);
        let edges = db::get_board_edges(conn, &board_id);
        (nodes, edges)
    })
}

#[tauri::command]
pub fn delete_board_cmd(board_id: String, state: State<AppState>) -> Result<bool, String> {
    with_conn(&state, |conn| db::delete_board(conn, &board_id))
}

#[tauri::command]
pub fn rename_board_cmd(
    board_id: String,
    req: RenameBoardReq,
    state: State<AppState>,
) -> Result<bool, String> {
    with_conn(&state, |conn| db::rename_board(conn, &board_id, &req.name))
}

#[tauri::command]
pub fn list_tags(state: State<AppState>) -> Result<Vec<TagInfo>, String> {
    with_conn(&state, |conn| db::list_tags(conn))
}

#[tauri::command]
pub fn set_tag_color(req: TagColorReq, state: State<AppState>) -> Result<(), String> {
    with_conn(&state, |conn| db::set_tag_color(conn, &req.name, req.color))
}

#[tauri::command]
pub fn delete_tag_color(req: TagNameReq, state: State<AppState>) -> Result<(), String> {
    with_conn(&state, |conn| db::delete_tag_color(conn, &req.name))
}

#[tauri::command]
pub fn save_to_trash(req: SaveTrashReq, state: State<AppState>) -> Result<(), String> {
    with_conn(&state, |conn| {
        db::save_to_trash(conn, &req.board_id, &req.card_id, &req.data)
    })
}

#[tauri::command]
pub fn list_trash(state: State<AppState>) -> Result<Vec<TrashEntry>, String> {
    with_conn(&state, |conn| db::list_trash(conn))
}

#[tauri::command]
pub fn restore_trash(id: i64, state: State<AppState>) -> Result<BoardNode, String> {
    with_conn(&state, |conn| db::restore_trash(conn, id))?
}

#[tauri::command]
pub fn delete_trash_entry(id: i64, state: State<AppState>) -> Result<(), String> {
    with_conn(&state, |conn| db::delete_trash_entry(conn, id))
}

#[tauri::command]
pub fn sync_trash(state: State<AppState>) -> Result<(), String> {
    with_conn(&state, |conn| db::sync_trash(conn))
}
