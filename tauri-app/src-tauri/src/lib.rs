mod db;
mod commands;
mod ai_sidecar;

use db::Db;
use ai_sidecar::Sidecar;
use std::sync::Mutex;
use std::path::PathBuf;
use std::sync::OnceLock;
use uuid::Uuid;

pub struct AppState {
    pub db: Mutex<Db>,
    pub sidecar: Mutex<Sidecar>,
}

#[tauri::command]
fn get_sidecar_url(state: tauri::State<AppState>) -> Result<String, String> {
    let sc = state.sidecar.lock().map_err(|e| e.to_string())?;
    sc.ensure_running()
}

// Set once at startup (after the app handle exists) so the image commands and
// the boardimg:// protocol handler can resolve user-data paths.
static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

fn data_dir() -> &'static PathBuf {
    DATA_DIR.get_or_init(|| PathBuf::from("."))
}

/// Count cards in a database (0 if missing/corrupt/unreadable).
fn card_count(path: &std::path::Path) -> i64 {
    let Ok(conn) = rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    ) else {
        return 0;
    };
    conn.query_row("SELECT COUNT(*) FROM board_cards", [], |r| r.get(0))
        .unwrap_or(0)
}

fn log_migration(msg: &str, new_dir: &std::path::Path) {
    use std::io::Write;
    let line = format!("{}: {}\n", chrono::Utc::now().to_rfc3339(), msg);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(new_dir.join("migration.log"))
    {
        let _ = f.write_all(line.as_bytes());
    }
}

/// One-time migration: older builds kept all user data (sessions.db +
/// board_images) in a portable `data/` folder next to the executable, which
/// can be wiped or relocated by installers. On first launch of a new build we
/// copy that data into the OS app-data dir (read-only-safe, survives
/// reinstalls) so existing users never lose boards, notes or settings.
///
/// This is also self-healing: if the new location somehow holds an empty DB
/// (e.g. a failed first run), it is replaced with the legacy DB. Every action
/// is logged to `migration.log` inside the new data dir.
fn migrate_legacy_data(new_dir: &std::path::Path, legacy_dir: &std::path::Path) {
    if !legacy_dir.exists() {
        return;
    }
    std::fs::create_dir_all(new_dir).ok();
    let legacy_db = legacy_dir.join("sessions.db");
    let new_db = new_dir.join("sessions.db");

    let legacy_count = if legacy_db.exists() { card_count(&legacy_db) } else { 0 };
    if legacy_count == 0 {
        // Legacy DB is missing or unreadable — nothing safe to migrate.
        return;
    }
    let new_count = if new_db.exists() { card_count(&new_db) } else { 0 };

    if !new_db.exists() {
        match std::fs::copy(&legacy_db, &new_db) {
            Ok(_) => log_migration(
                &format!("migrated legacy DB ({legacy_count} cards) -> {}", new_db.display()),
                new_dir,
            ),
            Err(e) => log_migration(&format!("FAILED copying legacy DB: {e}"), new_dir),
        }
    } else if new_count == 0 {
        // New DB exists but holds no data — restore from the legacy DB.
        let bak = new_dir.join("sessions.db.fresh-empty");
        if !bak.exists() {
            let _ = std::fs::copy(&new_db, &bak);
        }
        match std::fs::copy(&legacy_db, &new_db) {
            Ok(_) => log_migration(
                &format!("replaced empty DB with legacy DB ({legacy_count} cards restored)"),
                new_dir,
            ),
            Err(e) => log_migration(&format!("FAILED replacing empty DB: {e}"), new_dir),
        }
    } else {
        log_migration(
            &format!(
                "kept existing DB ({new_count} cards); legacy had {legacy_count}",
            ),
            new_dir,
        );
    }

    // Copy any board images that are missing from the new location.
    let new_imgs = new_dir.join("board_images");
    let legacy_imgs = legacy_dir.join("board_images");
    if legacy_imgs.exists() {
        std::fs::create_dir_all(&new_imgs).ok();
        if let Ok(entries) = std::fs::read_dir(&legacy_imgs) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let target = new_imgs.join(&name);
                if !target.exists() && std::fs::copy(entry.path(), &target).is_err() {
                    log_migration(
                        &format!("failed copying image {}", name.to_string_lossy()),
                        new_dir,
                    );
                }
            }
        }
    }
}

const ALLOWED_IMG_EXT: [&str; 12] = [
    ".png", ".jpg", ".jpeg", ".jfif", ".gif", ".webp", ".bmp", ".svg", ".ico", ".tif",
    ".tiff", ".avif",
];

/// Validate + store raw image bytes into data/board_images; returns the id.
fn store_board_image(bytes: Vec<u8>, ext: &str) -> Result<String, String> {
    let ext = ext.to_lowercase();
    if !ALLOWED_IMG_EXT.contains(&ext.as_str()) {
        return Err(format!("Unsupported image type '{ext}'."));
    }
    if bytes.len() > 8 * 1024 * 1024 {
        return Err("Image too large (max 8 MB).".to_string());
    }
    let dir = data_dir().join("board_images");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let id = Uuid::new_v4().simple().to_string()[..16].to_string();
    let dest = dir.join(format!("{id}{ext}"));
    std::fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
    Ok(id)
}

/// Save a board image to disk; returns an id + URL served via the boardimg:// protocol.
#[tauri::command]
fn save_board_image(bytes: Vec<u8>, ext: String) -> Result<serde_json::Value, String> {
    let id = store_board_image(bytes, &ext)?;
    Ok(serde_json::json!({
        "id": id,
        "url": format!("boardimg://localhost/{id}"),
        "ext": ext,
    }))
}

/// Save an image dropped from the OS (path based); returns its id.
#[tauri::command]
fn save_board_image_from_path(path: String) -> Result<serde_json::Value, String> {
    let ext = std::path::Path::new(&path)
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()))
        .unwrap_or_default();
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let id = store_board_image(bytes, &ext)?;
    Ok(serde_json::json!({ "id": id }))
}

/// Export a board as Markdown: writes the file into Documents/note-taker
/// exports/ (fallback: the app data dir) and reveals it in the file manager.
/// Returns the full path of the written file.
#[tauri::command]
fn save_markdown_export(
    app: tauri::AppHandle,
    filename: String,
    content: String,
) -> Result<String, String> {
    use tauri::Manager;
    use tauri_plugin_opener::OpenerExt;

    let base = app
        .path()
        .document_dir()
        .unwrap_or_else(|_| data_dir().clone());
    let dir = base.join("note-taker exports");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create export folder: {e}"))?;

    // Sanitize the base name (keep letters, digits, spaces, -_. ; collapse spaces).
    let clean: String = filename
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == ' ' || c == '-' || c == '_' || c == '.' {
                c
            } else {
                ' '
            }
        })
        .collect();
    let mut name = clean.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        name = "board".to_string();
    }

    let stamp = chrono::Local::now().format("%Y%m%d-%H%M");
    let path = dir.join(format!("{name}-{stamp}.md"));
    std::fs::write(&path, content).map_err(|e| format!("Cannot write file: {e}"))?;

    let _ = app.opener().reveal_item_in_dir(&path);
    Ok(path.to_string_lossy().to_string())
}

/// Serve a saved board image by id (matches the stored file regardless of ext).
fn serve_board_image(request: &tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    let id = request.uri().path().trim_start_matches('/');
    let dir = data_dir().join("board_images");
    let mut found: Option<(String, Vec<u8>)> = None;
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let stem = name.split('.').next().unwrap_or("");
            if stem == id {
                if let Ok(bytes) = std::fs::read(entry.path()) {
                    let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
                    let mime = match ext.as_str() {
                        "png" => "image/png",
                        "jpg" | "jpeg" | "jfif" => "image/jpeg",
                        "gif" => "image/gif",
                        "webp" => "image/webp",
                        "bmp" => "image/bmp",
                        "svg" => "image/svg+xml",
                        "ico" => "image/x-icon",
                        "tif" | "tiff" => "image/tiff",
                        "avif" => "image/avif",
                        _ => "application/octet-stream",
                    };
                    found = Some((mime.to_string(), bytes));
                }
                break;
            }
        }
    }
    match found {
        Some((mime, bytes)) => tauri::http::Response::builder()
            .header("Content-Type", mime)
            .header("Cache-Control", "no-cache")
            .body(bytes)
            .unwrap(),
        None => tauri::http::Response::builder()
            .status(404)
            .body(Vec::new())
            .unwrap(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            use tauri::Manager;

            // User data lives in the OS app-data dir (survives reinstalls and
            // read-only install locations). Fall back to a portable `data/`
            // folder next to the exe if the OS dir is unavailable.
            let exe_dir = std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|p| p.to_path_buf()))
                .unwrap_or_else(|| PathBuf::from("."));
            let dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| exe_dir.join("data"))
                .join("data");

            // Copy any pre-update portable data into the new location.
            migrate_legacy_data(&dir, &exe_dir.join("data"));

            let _ = DATA_DIR.set(dir.clone());
            let db = Db::new(&dir.join("sessions.db"));
            app.manage(AppState {
                db: Mutex::new(db),
                sidecar: Mutex::new(Sidecar::new(Some(dir.join("sidecar.log")))),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_boards,
            commands::create_board,
            commands::get_board,
            commands::put_board,
            commands::delete_board_cmd,
            commands::rename_board_cmd,
            commands::list_tags,
            commands::set_tag_color,
            commands::delete_tag_color,
            commands::save_to_trash,
            commands::list_trash,
            commands::restore_trash,
            commands::delete_trash_entry,
            commands::sync_trash,
            get_sidecar_url,
            save_board_image,
            save_board_image_from_path,
            save_markdown_export,
        ])
        .register_uri_scheme_protocol("boardimg", |_ctx, request| {
            serve_board_image(&request)
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                use tauri::Manager;
                let app = window.app_handle();
                if let Some(state) = app.try_state::<AppState>() {
                    if let Ok(sc) = state.sidecar.lock() {
                        sc.stop();
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
