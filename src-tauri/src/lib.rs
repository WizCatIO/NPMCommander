// NPM Commander - Tauri Backend
// Handles all system interactions: file operations, process management, dialogs

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

// Global state for running processes
pub struct AppState {
    processes: Mutex<HashMap<String, Child>>,
    last_project_path: Mutex<Option<String>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            processes: Mutex::new(HashMap::new()),
            last_project_path: Mutex::new(None),
        }
    }
}

#[derive(Serialize, Deserialize)]
pub struct ProjectInfo {
    name: String,
    version: String,
    scripts: HashMap<String, String>,
    dependencies: HashMap<String, String>,
    #[serde(rename = "devDependencies")]
    dev_dependencies: HashMap<String, String>,
    #[serde(rename = "nodeModulesInstalled")]
    node_modules_installed: bool,
    #[serde(rename = "projectPath")]
    project_path: String,
}

#[derive(Serialize, Deserialize)]
pub struct ProjectError {
    error: String,
}

#[derive(Serialize, Clone)]
pub struct ScriptOutput {
    script: String,
    #[serde(rename = "type")]
    output_type: String,
    data: String,
    tab_id: String,
}

#[derive(Serialize, Clone)]
pub struct ScriptExit {
    script: String,
    code: i32,
    tab_id: String,
}

#[derive(Serialize, Clone)]
pub struct PortInfo {
    port: u16,
    pid: String,
    process_name: String,
}

// Get settings path
fn get_settings_path() -> PathBuf {
    let config_dir = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    config_dir.join("npm-commander").join("settings.json")
}

// Load last used project path
fn load_last_path() -> Option<String> {
    let path = get_settings_path();
    if path.exists() {
        if let Ok(content) = fs::read_to_string(&path) {
            if let Ok(data) = serde_json::from_str::<serde_json::Value>(&content) {
                return data.get("lastProjectPath").and_then(|v| v.as_str()).map(String::from);
            }
        }
    }
    None
}

// Save last used project path
fn save_last_path(project_path: &str) {
    let path = get_settings_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let data = serde_json::json!({ "lastProjectPath": project_path });
    let _ = fs::write(&path, serde_json::to_string_pretty(&data).unwrap_or_default());
}

#[tauri::command]
fn get_default_path(state: State<AppState>) -> String {
    // First check for saved last path
    if let Some(last) = load_last_path() {
        if PathBuf::from(&last).exists() {
            return last;
        }
    }
    
    // Check in-memory state
    if let Ok(guard) = state.last_project_path.lock() {
        if let Some(ref path) = *guard {
            if PathBuf::from(path).exists() {
                return path.clone();
            }
        }
    }
    
    // Default to home directory
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "/".to_string())
}

#[tauri::command]
fn load_project(path: String, state: State<AppState>) -> Result<ProjectInfo, ProjectError> {
    let project_path = PathBuf::from(&path);
    let pkg_path = project_path.join("package.json");
    
    if !pkg_path.exists() {
        return Err(ProjectError {
            error: "No package.json found in this folder".to_string(),
        });
    }
    
    // Save path for next time
    save_last_path(&path);
    if let Ok(mut guard) = state.last_project_path.lock() {
        *guard = Some(path.clone());
    }
    
    // Read package.json
    let content = fs::read_to_string(&pkg_path).map_err(|e| ProjectError {
        error: format!("Failed to read package.json: {}", e),
    })?;
    
    let pkg: serde_json::Value = serde_json::from_str(&content).map_err(|e| ProjectError {
        error: format!("Invalid JSON in package.json: {}", e),
    })?;
    
    let name = pkg.get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("Unknown Project")
        .to_string();
    
    let version = pkg.get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("0.0.0")
        .to_string();
    
    let scripts = pkg.get("scripts")
        .and_then(|v| v.as_object())
        .map(|obj| {
            obj.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default();
    
    let dependencies = pkg.get("dependencies")
        .and_then(|v| v.as_object())
        .map(|obj| {
            obj.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default();
    
    let dev_dependencies = pkg.get("devDependencies")
        .and_then(|v| v.as_object())
        .map(|obj| {
            obj.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default();
    
    let node_modules_installed = project_path.join("node_modules").exists();
    
    Ok(ProjectInfo {
        name,
        version,
        scripts,
        dependencies,
        dev_dependencies,
        node_modules_installed,
        project_path: path,
    })
}

// No shared processes struct needed here

// Kill process on a specific port
fn kill_port(port: u16) {
    let port_str = format!(":{}", port);
    println!("Checking port {}", port);
    
    let output = Command::new("lsof")
        .args(["-i", &port_str, "-t"])
        .output();
        
    if let Ok(output) = output {
        let pids = String::from_utf8_lossy(&output.stdout);
        for pid in pids.lines() {
            let pid = pid.trim();
            if !pid.is_empty() {
                println!("Killing process {} on port {}", pid, port);
                let _ = Command::new("kill")
                    .arg("-9")
                    .arg(pid)
                    .output();
            }
        }
    }
}

// Cleanup dev environment (remove lock file, cleanup ports)
fn cleanup_dev_environment(project_path: &str) {
    let path = PathBuf::from(project_path);
    
    // 1. Remove .next/dev/lock
    let lock_file = path.join(".next/dev/lock");
    if lock_file.exists() {
        if let Err(e) = fs::remove_file(&lock_file) {
            eprintln!("Failed to remove lock file: {}", e);
        } else {
            println!("Removed stale lock file: {:?}", lock_file);
        }
    }
    
    // 2. Kill process on port 3000
    kill_port(3000);
}

#[tauri::command]
async fn kill_all_ports() -> Result<String, String> {
    let ports = [
        3000, 3001, 3002, 3003, 3004, 3005, 3006, 3007, 3008, 3009, 3010, // Common dev ports
        5173, // Vite
        8000, 8080, // Common HTTP
        5560, 8877 // User specific
    ];
    
    let mut killed_count = 0;
    
    // We can't easily know how many were actually killed without parsing lsof output deeper,
    // but we can iterate and try to kill all.
    for port in ports {
        kill_port(port);
        // We'll just assume success for the UI feedback for now, or could enhance kill_port to return bool
    }
    
    Ok("Cleanup command sent for all ports".to_string())
}

#[tauri::command]
async fn run_script(
    app: AppHandle,
    project_path: String,
    script_name: String,
    tab_id: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let process_key = format!("{}:{}", tab_id, script_name);

    // Check if already running
    {
        let processes = state.processes.lock().map_err(|e| e.to_string())?;
        if processes.contains_key(&process_key) {
            return Err(format!("Script '{}' is already running in this tab", script_name));
        }
    }
    
    // Check if we need to cleanup dev environment
    if ["dev", "start", "serve"].contains(&script_name.as_str()) {
        cleanup_dev_environment(&project_path);
    }

    // Spawn npm process using login shell to get PATH
    let command_str = format!("npm run {}", script_name);
    
    let mut child = Command::new("/bin/zsh")
        .args(["-lc", &command_str])
        .current_dir(&project_path)
        .env("FORCE_COLOR", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start script: {}", e))?;
    
    let script_name_clone = script_name.clone();
    let app_clone = app.clone();
    let tab_id_clone = tab_id.clone();
    
    // Read stdout in background
    if let Some(stdout) = child.stdout.take() {
        let script = script_name.clone();
        let app = app.clone();
        let t_id = tab_id.clone();
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                if let Ok(line) = line {
                    let _ = app.emit("script-output", ScriptOutput {
                        script: script.clone(),
                        output_type: "stdout".to_string(),
                        data: format!("{}\n", line),
                        tab_id: t_id.clone(),
                    });
                }
            }
        });
    }
    
    // Read stderr in background
    if let Some(stderr) = child.stderr.take() {
        let script = script_name.clone();
        let app = app.clone();
        let t_id = tab_id.clone();
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                if let Ok(line) = line {
                    let _ = app.emit("script-output", ScriptOutput {
                        script: script.clone(),
                        output_type: "stderr".to_string(),
                        data: format!("{}\n", line),
                        tab_id: t_id.clone(),
                    });
                }
            }
        });
    }
    
    // Store process
    {
        let mut processes = state.processes.lock().map_err(|e| e.to_string())?;
        processes.insert(process_key.clone(), child);
    }
    
    // Wait for process to exit in background using the app handle
    let script_for_monitor = process_key.clone();
    let script_name_for_exit = script_name_clone.clone();
    let tab_id_for_exit = tab_id_clone.clone();
    
    std::thread::spawn(move || {
        // Poll until process exits
        std::thread::sleep(std::time::Duration::from_millis(100));
        
        loop {
            std::thread::sleep(std::time::Duration::from_secs(1));
            
            // Try to get the process state from app
            let state = app_clone.try_state::<AppState>();
            if let Some(state) = state {
                if let Ok(mut processes) = state.processes.lock() {
                    if let Some(child) = processes.get_mut(&script_for_monitor) {
                        match child.try_wait() {
                            Ok(Some(status)) => {
                                let code = status.code().unwrap_or(-1);
                                processes.remove(&script_for_monitor);
                                let _ = app_clone.emit("script-exit", ScriptExit {
                                    script: script_name_for_exit.clone(),
                                    code,
                                    tab_id: tab_id_for_exit.clone(),
                                });
                                break;
                            }
                            Ok(None) => {
                                // Still running
                            }
                            Err(_) => {
                                processes.remove(&script_for_monitor);
                                break;
                            }
                        }
                    } else {
                        // Process was removed (stopped manually)
                        break;
                    }
                }
            } else {
                // App state not available, exit
                break;
            }
        }
    });
    
    Ok(true)
}

#[tauri::command]
fn stop_script(script_name: String, tab_id: String, state: State<AppState>) -> Result<bool, String> {
    let process_key = format!("{}:{}", tab_id, script_name);
    let mut processes = state.processes.lock().map_err(|e| e.to_string())?;
    
    if let Some(mut child) = processes.remove(&process_key) {
        let _ = child.kill();
        Ok(true)
    } else {
        Err("Script not running".to_string())
    }
}

#[tauri::command]
fn get_running_scripts(state: State<AppState>) -> Vec<String> {
    state.processes
        .lock()
        .map(|guard| guard.keys().cloned().collect())
        .unwrap_or_default()
}

#[tauri::command]
async fn install_deps(
    app: AppHandle,
    project_path: String,
    tab_id: String,
) -> Result<bool, String> {
    let mut child = Command::new("/bin/zsh")
        .args(["-lc", "npm install"])
        .current_dir(&project_path)
        .env("FORCE_COLOR", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to run npm install: {}", e))?;
    
    let tab_id_clone_stdout = tab_id.clone();
    let tab_id_clone_stderr = tab_id.clone();
    
    // Stream output
    if let Some(stdout) = child.stdout.take() {
        let app = app.clone();
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                if let Ok(line) = line {
                    let _ = app.emit("script-output", ScriptOutput {
                        script: "install".to_string(),
                        output_type: "stdout".to_string(),
                        data: format!("{}\n", line),
                        tab_id: tab_id_clone_stdout.clone(),
                    });
                }
            }
        });
    }
    
    if let Some(stderr) = child.stderr.take() {
        let app = app.clone();
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                if let Ok(line) = line {
                    let _ = app.emit("script-output", ScriptOutput {
                        script: "install".to_string(),
                        output_type: "stderr".to_string(),
                        data: format!("{}\n", line),
                        tab_id: tab_id_clone_stderr.clone(),
                    });
                }
            }
        });
    }
    
    let status = child.wait().map_err(|e| e.to_string())?;
    Ok(status.success())
}

#[tauri::command]
async fn kill_port_process() -> Result<String, String> {
    // macOS specific lsof and kill
    let output = Command::new("lsof")
        .args(["-i", ":3000", "-t"])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Ok("No process found on port 3000".to_string());
    }

    let pids = String::from_utf8_lossy(&output.stdout);
    let mut killed_count = 0;

    for pid in pids.lines() {
        if !pid.trim().is_empty() {
            let _ = Command::new("kill")
                .arg("-9")
                .arg(pid)
                .output();
            killed_count += 1;
        }
    }

    if killed_count > 0 {
        Ok(format!("Killed {} process(es) on port 3000", killed_count))
    } else {
        Ok("No process found on port 3000".to_string())
    }
}

#[tauri::command]
async fn list_open_ports() -> Result<Vec<PortInfo>, String> {
    let ports: Vec<u16> = vec![
        3000, 3001, 3002, 3003, 3004, 3005, 3006, 3007, 3008, 3009, 3010,
        5173, 8000, 8080, 5560, 8877,
    ];

    let mut results: Vec<PortInfo> = Vec::new();

    for port in ports {
        let port_arg = format!(":{}", port);
        let output = Command::new("lsof")
            .args(["-i", &port_arg, "-sTCP:LISTEN", "-n", "-P"])
            .output();

        if let Ok(output) = output {
            let text = String::from_utf8_lossy(&output.stdout);
            for line in text.lines().skip(1) {
                // skip header
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 2 {
                    let process_name = parts[0].to_string();
                    let pid = parts[1].to_string();
                    // Avoid duplicate PIDs for the same port
                    if !results.iter().any(|r| r.port == port && r.pid == pid) {
                        results.push(PortInfo {
                            port,
                            pid,
                            process_name,
                        });
                    }
                }
            }
        }
    }

    Ok(results)
}

#[tauri::command]
async fn kill_single_port(port: u16) -> Result<String, String> {
    let port_arg = format!(":{}", port);
    let output = Command::new("lsof")
        .args(["-i", &port_arg, "-t"])
        .output()
        .map_err(|e| e.to_string())?;

    let pids = String::from_utf8_lossy(&output.stdout);
    let mut killed_count = 0;

    for pid in pids.lines() {
        let pid = pid.trim();
        if !pid.is_empty() {
            let _ = Command::new("kill").arg("-9").arg(pid).output();
            killed_count += 1;
        }
    }

    if killed_count > 0 {
        Ok(format!("Killed {} process(es) on port {}", killed_count, port))
    } else {
        Ok(format!("No process found on port {}", port))
    }
}

#[tauri::command]
async fn reload_browser_tab(port: u16) -> Result<(), String> {
    let script = format!(
        r#"
        try
            tell application "Google Chrome"
                repeat with w in windows
                    repeat with t in tabs of w
                        if URL of t starts with "http://localhost:{port}" then
                            reload t
                        end if
                    end repeat
                end repeat
            end tell
        end try
        try
            tell application "Safari"
                repeat with w in windows
                    repeat with t in tabs of w
                        if URL of t starts with "http://localhost:{port}" then
                            tell t to do JavaScript "location.reload();"
                        end if
                    end repeat
                end repeat
            end tell
        end try
        "#
    );

    Command::new("osascript")
        .args(["-e", &script])
        .output()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            get_default_path,
            load_project,
            run_script,
            stop_script,
            get_running_scripts,
            install_deps,
            kill_all_ports,
            kill_port_process,
            list_open_ports,
            kill_single_port,
            reload_browser_tab,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
