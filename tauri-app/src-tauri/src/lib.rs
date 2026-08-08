mod db;
mod commands;
mod ai_sidecar;

use db::Db;
use ai_sidecar::Sidecar;
use std::sync::Mutex;
use std::path::PathBuf;
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

fn db_path() -> PathBuf {
    // Store the DB next to the executable (portable) — in dev this is the
    // target/debug dir; in a bundled app it's the install dir.
    let dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));
    let data_dir = dir.join("data");
    data_dir.join("sessions.db")
}

fn data_dir() -> PathBuf {
    db_path().parent().map(|p| p.to_path_buf()).unwrap_or_else(|| PathBuf::from("."))
}

const ALLOWED_IMG_EXT: [&str; 5] = [".png", ".jpg", ".jpeg", ".gif", ".webp"];

/// Save a board image to disk; returns an id + URL served via the boardimg:// protocol.
#[tauri::command]
fn save_board_image(bytes: Vec<u8>, ext: String) -> Result<serde_json::Value, String> {
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
    Ok(serde_json::json!({
        "id": id,
        "url": format!("boardimg://localhost/{id}"),
        "ext": ext,
    }))
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
                        "jpg" | "jpeg" => "image/jpeg",
                        "gif" => "image/gif",
                        "webp" => "image/webp",
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
    let path = db_path();
    let db = Db::new(&path);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            db: Mutex::new(db),
            sidecar: Mutex::new(Sidecar::new()),
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_boards,
            commands::create_board,
            commands::get_board,
            commands::put_board,
            commands::delete_board_cmd,
            commands::rename_board_cmd,
            get_sidecar_url,
            save_board_image,
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
