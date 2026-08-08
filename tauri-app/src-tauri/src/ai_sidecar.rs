use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

/// Manages the Python AI sidecar process.
/// The sidecar starts lazily (only when AI features are first needed).
pub struct Sidecar {
    child: Mutex<Option<Child>>,
    port: u16,
}

impl Sidecar {
    pub fn new() -> Self {
        Sidecar {
            child: Mutex::new(None),
            port: 8765,
        }
    }

    /// Find the Python executable: try .venv, then system python.
    fn find_python() -> Option<String> {
        // Check for a venv next to the sidecar script
        let candidates = [
            "python",
            "python3",
            "py",
        ];
        for cmd in &candidates {
            if which::which(cmd).is_ok() {
                return Some(cmd.to_string());
            }
        }
        None
    }

    /// Find the sidecar script path (next to the executable in dev, or bundled).
    fn find_script() -> Option<std::path::PathBuf> {
        let exe = std::env::current_exe().ok()?;
        let dir = exe.parent()?;
        // dev: <repo>/tauri-app/src-tauri/python/sidecar.py
        let dev_path = dir.join("python").join("sidecar.py");
        if dev_path.exists() {
            return Some(dev_path);
        }
        // bundled: <install>/python/sidecar.py
        let bundled = dir.join("python").join("sidecar.py");
        if bundled.exists() {
            return Some(bundled);
        }
        None
    }

    /// Start the sidecar if not already running. Returns the base URL.
    pub fn ensure_running(&self) -> Result<String, String> {
        let mut guard = self.child.lock().map_err(|e| e.to_string())?;
        if guard.is_some() {
            // check if still alive
            if let Some(ref mut child) = *guard {
                match child.try_wait() {
                    Ok(None) => return Ok(self.url()), // still running
                    _ => { *guard = None; } // died, restart
                }
            }
        }

        let python = Self::find_python()
            .ok_or_else(|| "Python not found. Install Python 3.12 and add to PATH.".to_string())?;
        let script = Self::find_script()
            .ok_or_else(|| "Sidecar script not found.".to_string())?;

        let child = Command::new(&python)
            .arg(&script)
            .env("SIDECAR_PORT", self.port.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Failed to start sidecar: {}", e))?;

        *guard = Some(child);
        Ok(self.url())
    }

    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    /// Stop the sidecar (called on app exit).
    pub fn stop(&self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(ref mut child) = *guard {
                let _ = child.kill();
            }
            *guard = None;
        }
    }
}
