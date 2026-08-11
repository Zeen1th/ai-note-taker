use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Data types (mirror the TS types in src/lib/types.ts)
// ---------------------------------------------------------------------------
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Board {
    pub id: String,
    pub name: String,
    pub source_session_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(rename = "nodeCount")]
    pub node_count: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BoardNode {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub text: String,
    pub c: i64,
    pub kind: String,
    pub image: String,
    #[serde(rename = "customTitle")]
    pub custom_title: Option<String>,
    pub blocks: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    /// kind 'node' containers hold cards with parentId = container id
    #[serde(rename = "parentId")]
    #[serde(default)]
    pub parent_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TagInfo {
    pub name: String,
    pub color: i64,
    pub count: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BoardEdge {
    pub id: String,
    #[serde(rename = "fromId")]
    pub from_id: String,
    #[serde(rename = "toId")]
    pub to_id: String,
    pub color: i64,
    pub label: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TrashEntry {
    pub id: i64,
    #[serde(rename = "boardId")]
    pub board_id: String,
    #[serde(rename = "cardId")]
    pub card_id: String,
    pub data: String,
    #[serde(rename = "deletedAt")]
    pub deleted_at: String,
}

// ---------------------------------------------------------------------------
// DB singleton
// ---------------------------------------------------------------------------
pub struct Db(pub Mutex<Connection>);

impl Db {
    pub fn new(path: &std::path::Path) -> Self {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        let conn = Connection::open(path).expect("failed to open database");
        init_db(&conn);
        Db(Mutex::new(conn))
    }
}

fn init_db(conn: &Connection) {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS boards (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            source_session_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS board_cards (
            id TEXT PRIMARY KEY,
            x REAL, y REAL, w REAL, h REAL,
            text TEXT, c INTEGER, kind TEXT, image TEXT,
            board_id TEXT,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS board_edges (
            id TEXT PRIMARY KEY,
            from_id TEXT NOT NULL,
            to_id TEXT NOT NULL,
            color INTEGER, label TEXT,
            board_id TEXT,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tag_colors (
            name TEXT PRIMARY KEY,
            color INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS trash (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            board_id TEXT NOT NULL,
            card_id TEXT NOT NULL UNIQUE,
            data TEXT NOT NULL,
            deleted_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_board_cards_board ON board_cards(board_id);
        CREATE INDEX IF NOT EXISTS idx_board_edges_board ON board_edges(board_id);
        ",
    )
    .expect("failed to init db");

    // Lightweight migrations for existing databases
    conn.execute("ALTER TABLE board_cards ADD COLUMN blocks TEXT", []).ok();
    conn.execute("ALTER TABLE board_cards ADD COLUMN custom_title TEXT", []).ok();
    conn.execute("ALTER TABLE board_cards ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'", []).ok();
    conn.execute("ALTER TABLE board_cards ADD COLUMN parent_id TEXT", []).ok();

    // Ensure at least one board exists
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM boards", [], |r| r.get(0))
        .unwrap_or(0);
    if count == 0 {
        let now = chrono::Utc::now().to_rfc3339();
        let id = Uuid::new_v4().simple().to_string()[..12].to_string();
        conn.execute(
            "INSERT INTO boards (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![id, "My board", now, now],
        )
        .ok();
    }
}

// ---------------------------------------------------------------------------
// Board queries
// ---------------------------------------------------------------------------
pub fn list_boards(conn: &Connection) -> Vec<Board> {
    let mut stmt = conn
        .prepare(
            "SELECT b.id, b.name, b.source_session_id, b.created_at, b.updated_at,
             (SELECT COUNT(*) FROM board_cards c WHERE c.board_id = b.id) as node_count
             FROM boards b ORDER BY b.updated_at DESC",
        )
        .unwrap();
    let rows = stmt.query_map([], |row| {
        Ok(Board {
            id: row.get(0)?,
            name: row.get(1)?,
            source_session_id: row.get(2)?,
            created_at: row.get(3)?,
            updated_at: row.get(4)?,
            node_count: row.get(5)?,
        })
    });
    rows.map(|r| r.filter_map(|x| x.ok()).collect()).unwrap_or_default()
}

pub fn create_board(conn: &Connection, name: &str, source_session_id: &str) -> Board {
    let id = Uuid::new_v4().simple().to_string()[..12].to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let name = if name.is_empty() { "Untitled board" } else { name };
    conn.execute(
        "INSERT INTO boards (id, name, source_session_id, created_at, updated_at) VALUES (?1,?2,?3,?4,?5)",
        rusqlite::params![id, name, source_session_id, now, now],
    )
    .ok();
    Board {
        id,
        name: name.to_string(),
        source_session_id: Some(source_session_id.to_string()),
        created_at: now.clone(),
        updated_at: now,
        node_count: 0,
    }
}

pub fn get_board_nodes(conn: &Connection, board_id: &str) -> Vec<BoardNode> {
    let mut stmt = conn
        .prepare(
            "SELECT id, x, y, w, h, text, c, kind, image, custom_title, blocks, tags, parent_id
             FROM board_cards WHERE board_id = ?1 ORDER BY updated_at ASC",
        )
        .unwrap();
    let rows = stmt.query_map([board_id], |row| {
        Ok(BoardNode {
            id: row.get(0)?,
            x: row.get(1)?,
            y: row.get(2)?,
            w: row.get(3)?,
            h: row.get(4)?,
            text: row.get(5)?,
            c: row.get(6)?,
            kind: row.get(7)?,
            image: row.get(8).unwrap_or_default(),
            custom_title: row.get(9).ok(),
            blocks: row.get(10).ok(),
            tags: parse_tags(row.get::<_, String>(11).unwrap_or_default()),
            parent_id: row.get(12).ok(),
        })
    });
    rows.map(|r| r.filter_map(|x| x.ok()).collect()).unwrap_or_default()
}

fn parse_tags(raw: String) -> Vec<String> {
    serde_json::from_str(&raw).unwrap_or_default()
}

pub fn get_board_edges(conn: &Connection, board_id: &str) -> Vec<BoardEdge> {
    let mut stmt = conn
        .prepare(
            "SELECT id, from_id, to_id, color, label FROM board_edges
             WHERE board_id = ?1 ORDER BY updated_at ASC",
        )
        .unwrap();
    let rows = stmt.query_map([board_id], |row| {
        Ok(BoardEdge {
            id: row.get(0)?,
            from_id: row.get(1)?,
            to_id: row.get(2)?,
            color: row.get(3)?,
            label: row.get(4).unwrap_or_default(),
        })
    });
    rows.map(|r| r.filter_map(|x| x.ok()).collect()).unwrap_or_default()
}

pub fn replace_board(
    conn: &Connection,
    board_id: &str,
    nodes: &[BoardNode],
    edges: &[serde_json::Value],
) {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute("DELETE FROM board_cards WHERE board_id = ?1", [board_id])
        .ok();
    conn.execute("DELETE FROM board_edges WHERE board_id = ?1", [board_id])
        .ok();

    for n in nodes {
        conn.execute(
            "INSERT INTO board_cards (id,x,y,w,h,text,c,kind,image,custom_title,blocks,tags,parent_id,board_id,updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
            rusqlite::params![
                n.id, n.x, n.y, n.w, n.h, n.text, n.c, n.kind,
                n.image, n.custom_title, n.blocks,
                serde_json::to_string(&n.tags).unwrap_or_else(|_| "[]".to_string()),
                n.parent_id, board_id, now
            ],
        )
        .ok();
    }

    for e in edges {
        let eid = e["id"].as_str().unwrap_or("");
        let from = e["from"].as_str().or(e["fromId"].as_str()).unwrap_or("");
        let to = e["to"].as_str().or(e["toId"].as_str()).unwrap_or("");
        let color = e["color"].as_i64().unwrap_or(0);
        let label = e["label"].as_str().unwrap_or("");
        if eid.is_empty() {
            continue;
        }
        conn.execute(
            "INSERT INTO board_edges (id,from_id,to_id,color,label,board_id,updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7)",
            rusqlite::params![eid, from, to, color, label, board_id, now],
        )
        .ok();
    }

    // bump board updated_at
    conn.execute(
        "UPDATE boards SET updated_at = ?1 WHERE id = ?2",
        rusqlite::params![now, board_id],
    )
    .ok();
}

pub fn delete_board(conn: &Connection, board_id: &str) -> bool {
    let rows = conn
        .execute("DELETE FROM boards WHERE id = ?1", [board_id])
        .unwrap_or(0);
    if rows > 0 {
        conn.execute("DELETE FROM board_cards WHERE board_id = ?1", [board_id])
            .ok();
        conn.execute("DELETE FROM board_edges WHERE board_id = ?1", [board_id])
            .ok();
        true
    } else {
        false
    }
}

pub fn rename_board(conn: &Connection, board_id: &str, name: &str) -> bool {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE boards SET name = ?1, updated_at = ?2 WHERE id = ?3",
        rusqlite::params![name, now, board_id],
    )
    .unwrap_or(0)
        > 0
}

pub fn first_board_id(conn: &Connection) -> Option<String> {
    conn.query_row(
        "SELECT id FROM boards ORDER BY updated_at DESC LIMIT 1",
        [],
        |row| row.get(0),
    )
    .ok()
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------
/// All tags across every board, with usage counts and stored colors.
/// Tags that exist only in tag_colors (created but not yet used) are listed
/// with count 0. Color 0 means "unassigned" (frontend picks a deterministic default).
pub fn list_tags(conn: &Connection) -> Vec<TagInfo> {
    let mut stmt = conn
        .prepare(
            "WITH used AS (
                SELECT tag.value AS name, COUNT(*) AS count
                FROM board_cards c, json_each(c.tags) AS tag
                GROUP BY tag.value
             )
             SELECT a.name,
                    COALESCE(tc.color, 0) AS color,
                    a.count AS count
             FROM (
                SELECT name, count FROM used
                UNION
                SELECT name, 0 FROM tag_colors
                WHERE name NOT IN (SELECT name FROM used)
             ) a
             LEFT JOIN tag_colors tc ON tc.name = a.name
             ORDER BY a.count DESC, a.name ASC",
        )
        .unwrap();
    let rows = stmt.query_map([], |row| {
        Ok(TagInfo {
            name: row.get(0)?,
            color: row.get(1)?,
            count: row.get(2)?,
        })
    });
    rows.map(|r| r.filter_map(|x| x.ok()).collect()).unwrap_or_default()
}

pub fn set_tag_color(conn: &Connection, name: &str, color: i64) {
    conn.execute(
        "INSERT INTO tag_colors (name, color) VALUES (?1, ?2)
         ON CONFLICT(name) DO UPDATE SET color = excluded.color",
        rusqlite::params![name, color],
    )
    .ok();
}

pub fn delete_tag_color(conn: &Connection, name: &str) {
    conn.execute("DELETE FROM tag_colors WHERE name = ?1", [name]).ok();
}

// ---------------------------------------------------------------------------
// Trash (deleted notes history)
// ---------------------------------------------------------------------------
pub fn save_to_trash(conn: &Connection, board_id: &str, card_id: &str, data: &str) {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO trash (board_id, card_id, data, deleted_at) VALUES (?1,?2,?3,?4)
         ON CONFLICT(card_id) DO UPDATE SET board_id = excluded.board_id,
                                            data = excluded.data,
                                            deleted_at = excluded.deleted_at",
        rusqlite::params![board_id, card_id, data, now],
    )
    .ok();
}

pub fn list_trash(conn: &Connection) -> Vec<TrashEntry> {
    let mut stmt = conn
        .prepare("SELECT id, board_id, card_id, data, deleted_at FROM trash ORDER BY deleted_at DESC")
        .unwrap();
    let rows = stmt.query_map([], |row| {
        Ok(TrashEntry {
            id: row.get(0)?,
            board_id: row.get(1)?,
            card_id: row.get(2)?,
            data: row.get(3)?,
            deleted_at: row.get(4)?,
        })
    });
    rows.map(|r| r.filter_map(|x| x.ok()).collect()).unwrap_or_default()
}

/// Re-insert a trashed card into its original board (same id), then drop the
/// trash row. Returns the restored node (or an error if it no longer exists).
pub fn restore_trash(conn: &Connection, trash_id: i64) -> Result<BoardNode, String> {
    let row: Option<(String, String, String)> = conn
        .query_row(
            "SELECT board_id, card_id, data FROM trash WHERE id = ?1",
            [trash_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .ok();
    let (board_id, card_id, data) = row.ok_or_else(|| "Trash entry not found".to_string())?;
    let node: BoardNode =
        serde_json::from_str(&data).map_err(|e| format!("Bad node data: {}", e))?;
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT OR IGNORE INTO board_cards
           (id,x,y,w,h,text,c,kind,image,custom_title,blocks,tags,parent_id,board_id,updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
        rusqlite::params![
            card_id, node.x, node.y, node.w, node.h, node.text, node.c, node.kind,
            node.image, node.custom_title, node.blocks,
            serde_json::to_string(&node.tags).unwrap_or_else(|_| "[]".to_string()),
            node.parent_id, board_id, now
        ],
    )
    .ok();
    conn.execute("DELETE FROM trash WHERE id = ?1", [trash_id]).ok();
    conn.execute(
        "UPDATE boards SET updated_at = ?1 WHERE id = ?2",
        rusqlite::params![now, board_id],
    )
    .ok();
    Ok(node)
}

/// Permanently discard a trash entry without restoring it.
pub fn delete_trash_entry(conn: &Connection, trash_id: i64) {
    conn.execute("DELETE FROM trash WHERE id = ?1", [trash_id]).ok();
}

/// Drop trash rows for cards that already exist again (e.g. after undo).
pub fn sync_trash(conn: &Connection) {
    conn.execute(
        "DELETE FROM trash WHERE card_id IN (SELECT id FROM board_cards)",
        [],
    )
    .ok();
}
