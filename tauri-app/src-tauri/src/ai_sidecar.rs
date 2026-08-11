use std::net::TcpStream;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Manages the Python AI sidecar process.
/// The sidecar starts lazily (only when AI features are first needed).
pub struct Sidecar {
    child: Mutex<Option<Child>>,
    port: u16,
    log_path: Option<std::path::PathBuf>,
}

impl Sidecar {
    pub fn new(log_path: Option<std::path::PathBuf>) -> Self {
        Sidecar {
            child: Mutex::new(None),
            port: 8766,
            log_path,
        }
    }

    /// Find the Python executable: prefer a bundled venv next to the sidecar
    /// script (src-tauri/python/.venv in dev, python/.venv in the installer),
    /// then fall back to interpreters on PATH.
    fn find_python(script_dir: &std::path::Path) -> Option<String> {
        let venv_exe = script_dir
            .join(".venv")
            .join("Scripts")
            .join("python.exe");
        let venv_exe2 = script_dir.join("venv").join("Scripts").join("python.exe");
        if venv_exe.exists() {
            return venv_exe.to_str().map(|s| s.to_string());
        }
        if venv_exe2.exists() {
            return venv_exe2.to_str().map(|s| s.to_string());
        }
        let candidates = ["python", "python3", "py"];
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
        // bundled: <install>/python/sidecar.py
        let p = dir.join("python").join("sidecar.py");
        if p.exists() {
            return Some(p);
        }
        None
    }

    /// True once the sidecar HTTP server is actually accepting connections.
    fn port_open(&self) -> bool {
        TcpStream::connect(("127.0.0.1", self.port)).is_ok()
    }

    fn tail_log(&self, lines: usize) -> String {
        let Some(path) = &self.log_path else { return String::new() };
        let Ok(content) = std::fs::read_to_string(path) else { return String::new() };
        content
            .lines()
            .rev()
            .take(lines)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Start the sidecar if not already running. Waits until the server is
    /// actually reachable (up to ~30 s for first-time model imports).
    pub fn ensure_running(&self) -> Result<String, String> {
        let mut guard = self.child.lock().map_err(|e| e.to_string())?;
        if guard.is_some() {
            if let Some(ref mut child) = *guard {
                match child.try_wait() {
                    Ok(None) if self.port_open() => return Ok(self.url()), // still running
                    Ok(None) => { /* process alive but not ready yet */ }
                    _ => { *guard = None; } // died, restart
                }
            }
        }

        let script = Self::find_script()
            .ok_or_else(|| "Sidecar script not found.".to_string())?;
        let python = Self::find_python(script.parent().unwrap_or(Path::new(".")))
            .ok_or_else(|| "Python not found. Install Python 3.11+ and add it to PATH.".to_string())?;

        // stream the sidecar's output to a log file so failures are diagnosable
        let log_file = self.log_path.clone().and_then(|p| {
            if let Some(parent) = p.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            std::fs::File::create(&p).ok()
        });
        let stdout = log_file
            .as_ref()
            .and_then(|f| f.try_clone().ok())
            .map(Stdio::from)
            .unwrap_or(Stdio::null());
        let stderr = log_file.map(Stdio::from).unwrap_or(Stdio::null());

        let mut child = Command::new(&python)
            .arg(&script)
            .env("SIDECAR_PORT", self.port.to_string())
            .stdout(stdout)
            .stderr(stderr)
            .spawn()
            .map_err(|e| format!("Failed to start sidecar: {}", e))?;

        // Wait for the server to come up (uvicorn imports can take a while).
        let deadline = Instant::now() + Duration::from_secs(30);
        while Instant::now() < deadline {
            match child.try_wait() {
                Ok(Some(status)) => {
                    let log = self.tail_log(8);
                    let hint = if log.is_empty() {
                        String::new()
                    } else {
                        format!("\n\nSidecar log tail:\n{log}")
                    };
                    return Err(format!(
                        "AI engine failed to start (exit code {}). Most likely the Python \
                         dependencies are missing. Run:\n  python -m pip install -r \
                         src-tauri/python/requirements.txt\n\nThen restart the app.{hint}",
                        status.code().unwrap_or(-1)
                    ));
                }
                Ok(None) => {}
                Err(_) => return Err("AI engine process died unexpectedly.".to_string()),
            }
            if self.port_open() {
                *guard = Some(child);
                return Ok(self.url());
            }
            std::thread::sleep(Duration::from_millis(300));
        }

        // Timeout: kill it and report the log so the user can see what happened.
        let _ = child.kill();
        let log = self.tail_log(8);
        let hint = if log.is_empty() {
            String::new()
        } else {
            format!("\n\nSidecar log tail:\n{log}")
        };
        Err(format!(
            "AI engine took too long to start (30 s). Check that Python has the sidecar \
             dependencies:\n  python -m pip install -r src-tauri/python/requirements.txt{hint}"
        ))
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
