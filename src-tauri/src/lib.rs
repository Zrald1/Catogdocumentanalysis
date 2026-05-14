mod google_auth;
mod knowledge_base;
mod knowledge_graph;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Manager, RunEvent, WindowEvent};

#[tauri::command]
fn append_system_log(app: tauri::AppHandle, entry: String) -> Result<String, String> {
  let log_path = resolve_system_log_path(&app)?;
  let log_dir = log_path
    .parent()
    .ok_or_else(|| format!("failed to resolve parent directory for {}", log_path.display()))?;
  std::fs::create_dir_all(&log_dir)
    .map_err(|error| format!("failed to create system log directory {}: {error}", log_dir.display()))?;

  let mut line = entry.replace('\r', "\\r").replace('\n', "\\n");
  line.push('\n');

  use std::io::Write;
  let mut file = std::fs::OpenOptions::new()
    .create(true)
    .append(true)
    .open(&log_path)
    .map_err(|error| format!("failed to open system log {}: {error}", log_path.display()))?;
  file
    .write_all(line.as_bytes())
    .map_err(|error| format!("failed to write system log {}: {error}", log_path.display()))?;

  Ok(log_path.display().to_string())
}

fn resolve_system_log_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
  let log_dir = app
    .path()
    .app_log_dir()
    .or_else(|_| std::env::current_dir())
    .map_err(|error| format!("failed to resolve system log directory: {error}"))?;
  Ok(log_dir.join("systemlogs.txt"))
}

fn append_native_lifecycle_log(app: &tauri::AppHandle, event: &str, message: String) {
  let Ok(log_path) = resolve_system_log_path(app) else {
    return;
  };
  let Some(log_dir) = log_path.parent() else {
    return;
  };
  if std::fs::create_dir_all(log_dir).is_err() {
    return;
  }

  let timestamp = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|duration| duration.as_millis().to_string())
    .unwrap_or_else(|_| "0".to_string());
  let line = format!(
    "{{\"atUnixMs\":\"{}\",\"level\":\"warn\",\"scope\":\"tauri.lifecycle\",\"event\":\"{}\",\"message\":\"{}\"}}\n",
    timestamp,
    event.replace('"', "\\\""),
    message.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n").replace('\r', "\\r"),
  );
  let _ = std::fs::OpenOptions::new()
    .create(true)
    .append(true)
    .open(&log_path)
    .and_then(|mut file| {
      use std::io::Write;
      file.write_all(line.as_bytes())
    });
}

#[tauri::command]
fn get_system_log_path(app: tauri::AppHandle) -> Result<String, String> {
  Ok(resolve_system_log_path(&app)?.display().to_string())
}

#[tauri::command]
fn open_system_log(app: tauri::AppHandle) -> Result<String, String> {
  let log_path = resolve_system_log_path(&app)?;
  if let Some(log_dir) = log_path.parent() {
    std::fs::create_dir_all(log_dir)
      .map_err(|error| format!("failed to create system log directory {}: {error}", log_dir.display()))?;
  }

  if !log_path.exists() {
    std::fs::write(&log_path, "")
      .map_err(|error| format!("failed to create system log {}: {error}", log_path.display()))?;
  }

  open::that(&log_path)
    .map_err(|error| format!("failed to open system log {}: {error}", log_path.display()))?;

  Ok(log_path.display().to_string())
}

#[tauri::command]
fn read_system_log(app: tauri::AppHandle) -> Result<String, String> {
  let log_path = resolve_system_log_path(&app)?;
  if !log_path.exists() {
    return Ok("".to_string());
  }
  std::fs::read_to_string(&log_path)
    .map_err(|error| format!("failed to read system log from {}: {error}", log_path.display()))
}

#[tauri::command]
fn save_binary_file(path: String, bytes: Vec<u8>, open_after_save: Option<bool>) -> Result<(), String> {
  std::fs::write(&path, bytes)
    .map_err(|error| format!("failed to save file to {path}: {error}"))?;

  if open_after_save.unwrap_or(false) {
    open::that(&path)
      .map_err(|error| format!("saved file to {path}, but failed to open it automatically: {error}"))?;
  }

  Ok(())
}

#[tauri::command]
fn run_local_ocr(file_name: String, bytes: Vec<u8>) -> Result<String, String> {
  let extension = std::path::Path::new(&file_name)
    .extension()
    .and_then(|value| value.to_str())
    .unwrap_or("png");
  let timestamp = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map_err(|error| format!("failed to prepare OCR timestamp: {error}"))?
    .as_millis();
  let temp_path = std::env::temp_dir().join(format!("catog-ocr-{timestamp}.{extension}"));

  std::fs::write(&temp_path, bytes)
    .map_err(|error| format!("failed to prepare OCR image: {error}"))?;

  let output = Command::new("tesseract")
    .arg(&temp_path)
    .arg("stdout")
    .arg("--psm")
    .arg("6")
    .output()
    .map_err(|error| format!("failed to launch Tesseract OCR: {error}"))?;

  let _ = std::fs::remove_file(&temp_path);

  if !output.status.success() {
    return Err(format!(
      "Tesseract OCR failed: {}",
      String::from_utf8_lossy(&output.stderr).trim()
    ));
  }

  Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[tauri::command]
async fn query_knowledge_base(
  config: knowledge_base::KnowledgeBaseConfig,
  query: String,
  limit: Option<usize>,
) -> Result<Vec<knowledge_base::KnowledgeBaseSearchResult>, String> {
  knowledge_base::query_knowledge_base(config, query, limit).await
}

#[tauri::command]
async fn test_knowledge_base_connection(
  config: knowledge_base::KnowledgeBaseConfig,
) -> Result<knowledge_base::KnowledgeBaseConnectionTestResult, String> {
  knowledge_base::test_knowledge_base_connection(config).await
}

#[tauri::command]
async fn ingest_knowledge_base_files(
  config: knowledge_base::KnowledgeBaseConfig,
  documents: Vec<knowledge_base::KnowledgeBaseIngestionDocument>,
) -> Result<knowledge_base::KnowledgeBaseIngestionResult, String> {
  knowledge_base::ingest_knowledge_base_files(config, documents).await
}

#[tauri::command]
async fn list_knowledge_base_documents(
  config: knowledge_base::KnowledgeBaseConfig,
) -> Result<Vec<knowledge_base::KnowledgeBaseIndexedDocument>, String> {
  knowledge_base::list_knowledge_base_documents(config).await
}

#[tauri::command]
async fn delete_knowledge_base_documents(
  config: knowledge_base::KnowledgeBaseConfig,
  file_names: Vec<String>,
) -> Result<knowledge_base::KnowledgeBaseDeleteDocumentsResult, String> {
  knowledge_base::delete_knowledge_base_documents(config, file_names).await
}

#[tauri::command]
async fn test_knowledge_graph_connection(
  config: knowledge_base::KnowledgeBaseConfig,
) -> Result<knowledge_graph::KnowledgeGraphConnectionTestResult, String> {
  knowledge_graph::test_knowledge_graph_connection(config).await
}

#[tauri::command]
async fn ingest_knowledge_graph_document(
  config: knowledge_base::KnowledgeBaseConfig,
  document: knowledge_graph::KnowledgeGraphDocumentInput,
) -> Result<knowledge_graph::KnowledgeGraphIngestionResult, String> {
  knowledge_graph::ingest_knowledge_graph_document(config, document).await
}

#[tauri::command]
async fn query_knowledge_graph(
  config: knowledge_base::KnowledgeBaseConfig,
  scope: String,
  source_document_id: Option<String>,
) -> Result<knowledge_graph::KnowledgeGraphData, String> {
  knowledge_graph::query_knowledge_graph(config, scope, source_document_id).await
}

#[tauri::command]
async fn get_google_auth_status(
  app: tauri::AppHandle,
) -> Result<google_auth::GoogleAuthStatus, String> {
  google_auth::get_google_auth_status(&app).await
}

#[tauri::command]
async fn sign_in_with_google(
  app: tauri::AppHandle,
) -> Result<google_auth::GoogleAuthStatus, String> {
  google_auth::sign_in_with_google(&app).await
}

#[tauri::command]
async fn sign_out_google(
  app: tauri::AppHandle,
) -> Result<google_auth::GoogleAuthStatus, String> {
  google_auth::sign_out_google(&app).await
}

#[tauri::command]
async fn verify_google_auth(
  app: tauri::AppHandle,
) -> Result<google_auth::GoogleAuthVerification, String> {
  google_auth::verify_google_auth(&app).await
}

#[tauri::command]
async fn generate_google_content(
  app: tauri::AppHandle,
  request: google_auth::GoogleGenerateContentRequest,
) -> Result<google_auth::GoogleGenerateContentResponse, String> {
  google_auth::generate_google_content(&app, request).await
}

#[tauri::command]
fn persist_analysis_history(app: tauri::AppHandle, payload: String) -> Result<(), String> {
  let data_dir = app
    .path()
    .app_data_dir()
    .or_else(|_| std::env::current_dir())
    .map_err(|error| format!("failed to resolve app data directory: {error}"))?;
  
  std::fs::create_dir_all(&data_dir)
    .map_err(|error| format!("failed to create app data directory {}: {error}", data_dir.display()))?;

  let history_path = data_dir.join("analysis_history.json");
  std::fs::write(&history_path, payload)
    .map_err(|error| format!("failed to persist analysis history to {}: {error}", history_path.display()))?;

  Ok(())
}

#[tauri::command]
fn load_analysis_history(app: tauri::AppHandle) -> Result<String, String> {
  let history_path = app
    .path()
    .app_data_dir()
    .or_else(|_| std::env::current_dir())
    .map_err(|error| format!("failed to resolve app data directory: {error}"))?
    .join("analysis_history.json");

  if !history_path.exists() {
    return Ok("{}".to_string());
  }

  std::fs::read_to_string(&history_path)
    .map_err(|error| format!("failed to load analysis history from {}: {error}", history_path.display()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  std::panic::set_hook(Box::new(|panic_info| {
    eprintln!("CATOG panic: {panic_info}");
  }));

  let app = tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .on_page_load(|webview, payload| {
      append_native_lifecycle_log(
        webview.app_handle(),
        "page-load",
        format!(
          "label={} event={:?} url={}",
          webview.label(),
          payload.event(),
          payload.url()
        ),
      );
    })
    .on_window_event(|window, event| {
      match event {
        WindowEvent::CloseRequested { .. } => append_native_lifecycle_log(
          window.app_handle(),
          "window-close-requested",
          format!("label={}", window.label()),
        ),
        WindowEvent::Destroyed => append_native_lifecycle_log(
          window.app_handle(),
          "window-destroyed",
          format!("label={}", window.label()),
        ),
        WindowEvent::Focused(focused) => append_native_lifecycle_log(
          window.app_handle(),
          "window-focused",
          format!("label={} focused={focused}", window.label()),
        ),
        _ => {}
      }
    })
    .setup(|app| {
      append_native_lifecycle_log(app.handle(), "app-setup", "Tauri setup started".to_string());
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      save_binary_file,
      query_knowledge_base,
      test_knowledge_base_connection,
      ingest_knowledge_base_files,
      list_knowledge_base_documents,
      delete_knowledge_base_documents,
      test_knowledge_graph_connection,
      ingest_knowledge_graph_document,
      query_knowledge_graph,
      get_google_auth_status,
      sign_in_with_google,
      sign_out_google,
      verify_google_auth,
      generate_google_content,
      run_local_ocr,
      append_system_log,
      read_system_log,
      get_system_log_path,
      open_system_log,
      persist_analysis_history,
      load_analysis_history
    ])
    .build(tauri::generate_context!())
    .expect("error while building tauri application");

  app.run(|app_handle, event| match event {
    RunEvent::Ready => append_native_lifecycle_log(app_handle, "app-ready", "Tauri app is ready".to_string()),
    RunEvent::ExitRequested { code, .. } => append_native_lifecycle_log(
      app_handle,
      "exit-requested",
      format!("code={code:?}"),
    ),
    RunEvent::Exit => append_native_lifecycle_log(app_handle, "exit", "Tauri event loop exited".to_string()),
    RunEvent::WindowEvent { label, event, .. } => match event {
      WindowEvent::CloseRequested { .. } => append_native_lifecycle_log(
        app_handle,
        "run-window-close-requested",
        format!("label={label}"),
      ),
      WindowEvent::Destroyed => append_native_lifecycle_log(
        app_handle,
        "run-window-destroyed",
        format!("label={label}"),
      ),
      _ => {}
    },
    _ => {}
  });
}
