use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use url::Url;

const OAUTH_CLIENT_ID: &str =
  "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
const OAUTH_CLIENT_SECRET: &str = "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";
const GOOGLE_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL: &str = "https://www.googleapis.com/oauth2/v2/userinfo";
const CODE_ASSIST_BASE_URL: &str = "https://cloudcode-pa.googleapis.com/v1internal";
const CALLBACK_PATH: &str = "/oauth2callback";
const CREDENTIALS_FILE: &str = "google-auth.json";
const CALLBACK_TIMEOUT: Duration = Duration::from_secs(300);
const CODE_ASSIST_MIN_REQUEST_SPACING: Duration = Duration::from_secs(1);
const CODE_ASSIST_FALLBACK_RETRY_DELAY: Duration = Duration::from_secs(2);
const CODE_ASSIST_RETRY_BUFFER: Duration = Duration::from_secs(1);
const CODE_ASSIST_MAX_RETRY_DELAY: Duration = Duration::from_secs(300);
const CODE_ASSIST_MAX_ATTEMPTS: usize = 4;
const DEFAULT_FACTUAL_TEMPERATURE: f32 = 0.0;
const PROJECT_ENV_KEYS: [&str; 2] = ["GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT_ID"];
const OAUTH_SCOPES: [&str; 3] = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct StoredGoogleCredentials {
  access_token: String,
  refresh_token: Option<String>,
  token_type: Option<String>,
  scope: Option<String>,
  expires_at: Option<i64>,
  email: Option<String>,
  display_name: Option<String>,
  project_id: Option<String>,
  user_tier: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleAuthStatus {
  is_signed_in: bool,
  email: Option<String>,
  display_name: Option<String>,
  expires_at: Option<i64>,
  project_id: Option<String>,
  user_tier: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleAuthVerification {
  pub message: String,
  pub project_id: Option<String>,
  pub user_tier: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleGenerateContentRequest {
  pub model: String,
  pub prompt: Option<String>,
  pub parts: Option<Vec<GoogleGenerateContentPart>>,
  pub response_mime_type: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleGenerateContentPart {
  pub text: Option<String>,
  pub inline_data: Option<GoogleInlineData>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleInlineData {
  pub mime_type: String,
  pub data: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleGenerateContentResponse {
  pub text: String,
  pub model: String,
}

#[derive(Debug, Deserialize)]
struct OAuthTokenResponse {
  access_token: String,
  refresh_token: Option<String>,
  token_type: Option<String>,
  scope: Option<String>,
  expires_in: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct GoogleUserInfoResponse {
  email: Option<String>,
  name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LoadCodeAssistRequest {
  cloudaicompanion_project: Option<String>,
  metadata: ClientMetadata,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OnboardUserRequest {
  tier_id: String,
  cloudaicompanion_project: Option<String>,
  metadata: ClientMetadata,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientMetadata {
  ide_type: &'static str,
  platform: &'static str,
  plugin_type: &'static str,
  duet_project: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoadCodeAssistResponse {
  current_tier: Option<GeminiUserTier>,
  allowed_tiers: Option<Vec<GeminiUserTier>>,
  ineligible_tiers: Option<Vec<IneligibleTier>>,
  cloudaicompanion_project: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeminiUserTier {
  id: Option<String>,
  is_default: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IneligibleTier {
  reason_message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OperationResponse {
  name: Option<String>,
  done: Option<bool>,
  response: Option<OnboardUserResponse>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OnboardUserResponse {
  cloudaicompanion_project: Option<OnboardProject>,
}

#[derive(Debug, Deserialize)]
struct OnboardProject {
  id: Option<String>,
}

fn code_assist_next_request_at() -> &'static Mutex<Option<Instant>> {
  static NEXT_REQUEST_AT: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();
  NEXT_REQUEST_AT.get_or_init(|| Mutex::new(None))
}

pub async fn get_google_auth_status(app: &AppHandle) -> Result<GoogleAuthStatus, String> {
  Ok(load_credentials(app)?.map(status_from_credentials).unwrap_or_else(signed_out_status))
}

pub async fn sign_in_with_google(app: &AppHandle) -> Result<GoogleAuthStatus, String> {
  let existing_credentials = load_credentials(app)?;
  let listener = TcpListener::bind("127.0.0.1:0")
    .map_err(|error| format!("Failed to bind Google OAuth callback server: {error}"))?;
  let port = listener
    .local_addr()
    .map_err(|error| format!("Failed to determine callback port: {error}"))?
    .port();

  let state = random_urlsafe(24);
  let code_verifier = random_urlsafe(64);
  let redirect_uri = format!("http://127.0.0.1:{port}{CALLBACK_PATH}");
  let auth_url = build_auth_url(&redirect_uri, &state, &code_verifier)?;

  open::that(auth_url.as_str())
    .map_err(|error| format!("Failed to open the browser for Google sign-in: {error}"))?;

  let callback_state = state.clone();
  let auth_code = tauri::async_runtime::spawn_blocking(move || {
    wait_for_oauth_code(listener, &callback_state)
  })
  .await
  .map_err(|error| format!("Google sign-in task failed: {error}"))??;

  let client = reqwest::Client::builder()
    .build()
    .map_err(|error| format!("Failed to create HTTP client: {error}"))?;

  let mut credentials = exchange_auth_code(&client, &auth_code, &code_verifier, &redirect_uri).await?;
  if credentials.refresh_token.is_none() {
    credentials.refresh_token = existing_credentials.and_then(|stored| stored.refresh_token);
  }

  if credentials.refresh_token.is_none() {
    return Err("Google sign-in succeeded, but no refresh token was returned. Please try signing in again.".to_string());
  }

  enrich_profile(&client, &mut credentials).await?;
  let _ = ensure_code_assist_context(&client, &mut credentials).await?;
  save_credentials(app, &credentials)?;

  Ok(status_from_credentials(credentials))
}

pub async fn sign_out_google(app: &AppHandle) -> Result<GoogleAuthStatus, String> {
  let path = credentials_path(app)?;
  if path.exists() {
    fs::remove_file(&path)
      .map_err(|error| format!("Failed to remove saved Google credentials: {error}"))?;
  }
  Ok(signed_out_status())
}

pub async fn verify_google_auth(app: &AppHandle) -> Result<GoogleAuthVerification, String> {
  let client = reqwest::Client::builder()
    .build()
    .map_err(|error| format!("Failed to create HTTP client: {error}"))?;
  let mut credentials = ensure_valid_credentials(app, &client).await?;
  let project_id = ensure_code_assist_context(&client, &mut credentials).await?;
  save_credentials(app, &credentials)?;

  Ok(GoogleAuthVerification {
    message: format!(
      "Google sign-in is ready. Code Assist project {} is available{}.",
      project_id,
      credentials
        .user_tier
        .as_ref()
        .map(|tier| format!(" for tier {tier}"))
        .unwrap_or_default()
    ),
    project_id: Some(project_id),
    user_tier: credentials.user_tier.clone(),
  })
}

pub async fn generate_google_content(
  app: &AppHandle,
  request: GoogleGenerateContentRequest,
) -> Result<GoogleGenerateContentResponse, String> {
  let parts = if let Some(parts) = request.parts.clone().filter(|parts| !parts.is_empty()) {
    parts
  } else if let Some(prompt) = request.prompt.clone() {
    if prompt.trim().is_empty() {
      return Err("A prompt is required before generating content with Google sign-in.".to_string());
    }

    vec![GoogleGenerateContentPart {
      text: Some(prompt),
      inline_data: None,
    }]
  } else {
    return Err("A prompt or multimodal parts payload is required before generating content with Google sign-in.".to_string());
  };

  let client = reqwest::Client::builder()
    .build()
    .map_err(|error| format!("Failed to create HTTP client: {error}"))?;
  let mut credentials = ensure_valid_credentials(app, &client).await?;
  let project_id = ensure_code_assist_context(&client, &mut credentials).await?;

  let body = json!({
    "model": request.model,
    "project": project_id,
    "user_prompt_id": random_urlsafe(18),
    "request": {
      "contents": [
        {
          "role": "user",
          "parts": parts
        }
      ],
      "generationConfig": {
        "responseMimeType": request.response_mime_type.unwrap_or_else(|| "text/plain".to_string()),
        "temperature": DEFAULT_FACTUAL_TEMPERATURE
      }
    }
  });

  let mut last_retry_error = None;
  let mut payload = None;

  for attempt in 0..CODE_ASSIST_MAX_ATTEMPTS {
    wait_for_code_assist_window().await?;

    let response = client
      .post(format!("{CODE_ASSIST_BASE_URL}:generateContent"))
      .bearer_auth(&credentials.access_token)
      .header("Content-Type", "application/json")
      .header("User-Agent", "CATOG-Tauri/0.1.0")
      .json(&body)
      .send()
      .await
      .map_err(|error| format!("Failed to call Google Code Assist: {error}"))?;

    if response.status().is_success() {
      payload = Some(
        response
          .json::<Value>()
          .await
          .map_err(|error| format!("Failed to parse Google generation response: {error}"))?,
      );
      break;
    }

    let status = response.status();
    let retry_after_header = response
      .headers()
      .get(reqwest::header::RETRY_AFTER)
      .and_then(|value| value.to_str().ok())
      .and_then(parse_retry_after_seconds)
      .map(Duration::from_secs_f64);
    let error_message = read_error_response(response).await;

    if status == StatusCode::TOO_MANY_REQUESTS || status == StatusCode::SERVICE_UNAVAILABLE {
      let retry_delay = retry_after_header
        .or_else(|| parse_code_assist_retry_delay(&error_message))
        .unwrap_or_else(|| fallback_retry_delay(attempt));

      if retry_delay <= CODE_ASSIST_MAX_RETRY_DELAY && attempt + 1 < CODE_ASSIST_MAX_ATTEMPTS {
        update_code_assist_cooldown(retry_delay + CODE_ASSIST_RETRY_BUFFER)?;
        last_retry_error = Some(error_message);
        continue;
      }
    }

    return Err(format!("Google Code Assist generation failed: {error_message}"));
  }

  let payload = payload.ok_or_else(|| {
    format!(
      "Google Code Assist generation failed after {} attempts: {}",
      CODE_ASSIST_MAX_ATTEMPTS,
      last_retry_error.unwrap_or_else(|| "request did not return content".to_string())
    )
  })?;
  save_credentials(app, &credentials)?;

  let text = extract_generated_text(&payload)
    .ok_or_else(|| "Google generation completed, but no text was returned.".to_string())?;

  Ok(GoogleGenerateContentResponse {
    text,
    model: request.model,
  })
}

fn status_from_credentials(credentials: StoredGoogleCredentials) -> GoogleAuthStatus {
  GoogleAuthStatus {
    is_signed_in: true,
    email: credentials.email,
    display_name: credentials.display_name,
    expires_at: credentials.expires_at,
    project_id: credentials.project_id,
    user_tier: credentials.user_tier,
  }
}

fn signed_out_status() -> GoogleAuthStatus {
  GoogleAuthStatus {
    is_signed_in: false,
    email: None,
    display_name: None,
    expires_at: None,
    project_id: None,
    user_tier: None,
  }
}

fn credentials_path(app: &AppHandle) -> Result<PathBuf, String> {
  let dir = app
    .path()
    .app_local_data_dir()
    .map_err(|error| format!("Failed to resolve the app data directory: {error}"))?;
  fs::create_dir_all(&dir)
    .map_err(|error| format!("Failed to prepare the app data directory: {error}"))?;
  Ok(dir.join(CREDENTIALS_FILE))
}

fn load_credentials(app: &AppHandle) -> Result<Option<StoredGoogleCredentials>, String> {
  let path = credentials_path(app)?;
  if !path.exists() {
    return Ok(None);
  }

  let contents = fs::read_to_string(&path)
    .map_err(|error| format!("Failed to read saved Google credentials: {error}"))?;
  let credentials = serde_json::from_str::<StoredGoogleCredentials>(&contents)
    .map_err(|error| format!("Failed to parse saved Google credentials: {error}"))?;
  Ok(Some(credentials))
}

fn save_credentials(app: &AppHandle, credentials: &StoredGoogleCredentials) -> Result<(), String> {
  let path = credentials_path(app)?;
  let data = serde_json::to_vec_pretty(credentials)
    .map_err(|error| format!("Failed to serialize Google credentials: {error}"))?;
  fs::write(&path, data)
    .map_err(|error| format!("Failed to save Google credentials: {error}"))?;

  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    let permissions = fs::Permissions::from_mode(0o600);
    fs::set_permissions(&path, permissions)
      .map_err(|error| format!("Failed to secure the saved Google credentials: {error}"))?;
  }

  Ok(())
}

async fn ensure_valid_credentials(
  app: &AppHandle,
  client: &reqwest::Client,
) -> Result<StoredGoogleCredentials, String> {
  let mut credentials = load_credentials(app)?
    .ok_or_else(|| "Google sign-in is required before this action can run.".to_string())?;

  if is_token_expired(&credentials) {
    refresh_access_token(client, &mut credentials).await?;
    enrich_profile(client, &mut credentials).await?;
    save_credentials(app, &credentials)?;
  }

  Ok(credentials)
}

fn is_token_expired(credentials: &StoredGoogleCredentials) -> bool {
  match credentials.expires_at {
    Some(expires_at) => expires_at <= unix_timestamp() + 30,
    None => true,
  }
}

async fn refresh_access_token(
  client: &reqwest::Client,
  credentials: &mut StoredGoogleCredentials,
) -> Result<(), String> {
  let refresh_token = credentials
    .refresh_token
    .clone()
    .ok_or_else(|| "Saved Google credentials do not include a refresh token. Please sign in again.".to_string())?;
  let response = client
    .post(GOOGLE_TOKEN_URL)
    .form(&[
      ("client_id", OAUTH_CLIENT_ID),
      ("client_secret", OAUTH_CLIENT_SECRET),
      ("refresh_token", refresh_token.as_str()),
      ("grant_type", "refresh_token"),
    ])
    .send()
    .await
    .map_err(|error| format!("Failed to refresh the Google access token: {error}"))?;

  if !response.status().is_success() {
    return Err(format!(
      "Google token refresh failed: {}",
      read_error_response(response).await
    ));
  }

  let token = response
    .json::<OAuthTokenResponse>()
    .await
    .map_err(|error| format!("Failed to parse the refreshed Google access token: {error}"))?;

  credentials.access_token = token.access_token;
  credentials.token_type = token.token_type;
  credentials.scope = token.scope;
  credentials.expires_at = token.expires_in.map(|expires_in| unix_timestamp() + expires_in);
  Ok(())
}

async fn enrich_profile(
  client: &reqwest::Client,
  credentials: &mut StoredGoogleCredentials,
) -> Result<(), String> {
  let response = client
    .get(GOOGLE_USERINFO_URL)
    .bearer_auth(&credentials.access_token)
    .send()
    .await
    .map_err(|error| format!("Failed to load Google account details: {error}"))?;

  if !response.status().is_success() {
    return Err(format!(
      "Google account lookup failed: {}",
      read_error_response(response).await
    ));
  }

  let user = response
    .json::<GoogleUserInfoResponse>()
    .await
    .map_err(|error| format!("Failed to parse Google account details: {error}"))?;
  credentials.email = user.email;
  credentials.display_name = user.name;
  Ok(())
}

async fn exchange_auth_code(
  client: &reqwest::Client,
  code: &str,
  code_verifier: &str,
  redirect_uri: &str,
) -> Result<StoredGoogleCredentials, String> {
  let response = client
    .post(GOOGLE_TOKEN_URL)
    .form(&[
      ("code", code),
      ("client_id", OAUTH_CLIENT_ID),
      ("client_secret", OAUTH_CLIENT_SECRET),
      ("redirect_uri", redirect_uri),
      ("grant_type", "authorization_code"),
      ("code_verifier", code_verifier),
    ])
    .send()
    .await
    .map_err(|error| format!("Failed to exchange the Google authorization code: {error}"))?;

  if !response.status().is_success() {
    return Err(format!(
      "Google authorization code exchange failed: {}",
      read_error_response(response).await
    ));
  }

  let token = response
    .json::<OAuthTokenResponse>()
    .await
    .map_err(|error| format!("Failed to parse the Google authorization response: {error}"))?;

  Ok(StoredGoogleCredentials {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    token_type: token.token_type,
    scope: token.scope,
    expires_at: token.expires_in.map(|expires_in| unix_timestamp() + expires_in),
    ..StoredGoogleCredentials::default()
  })
}

fn build_auth_url(
  redirect_uri: &str,
  state: &str,
  code_verifier: &str,
) -> Result<Url, String> {
  let code_challenge = pkce_challenge(code_verifier);
  let mut url = Url::parse(GOOGLE_AUTH_URL)
    .map_err(|error| format!("Failed to prepare the Google authorization URL: {error}"))?;
  url.query_pairs_mut()
    .append_pair("client_id", OAUTH_CLIENT_ID)
    .append_pair("redirect_uri", redirect_uri)
    .append_pair("response_type", "code")
    .append_pair("scope", &OAUTH_SCOPES.join(" "))
    .append_pair("access_type", "offline")
    .append_pair("prompt", "consent select_account")
    .append_pair("state", state)
    .append_pair("code_challenge", &code_challenge)
    .append_pair("code_challenge_method", "S256");
  Ok(url)
}

fn wait_for_oauth_code(listener: TcpListener, expected_state: &str) -> Result<String, String> {
  listener
    .set_nonblocking(true)
    .map_err(|error| format!("Failed to prepare the Google callback listener: {error}"))?;
  let deadline = Instant::now() + CALLBACK_TIMEOUT;

  while Instant::now() < deadline {
    match listener.accept() {
      Ok((mut stream, _)) => {
        stream
          .set_read_timeout(Some(Duration::from_secs(5)))
          .map_err(|error| format!("Failed to prepare the callback stream: {error}"))?;
        let mut buffer = [0_u8; 8192];
        let bytes_read = stream
          .read(&mut buffer)
          .map_err(|error| format!("Failed to read the Google callback request: {error}"))?;
        let request = String::from_utf8_lossy(&buffer[..bytes_read]);
        let request_line = request
          .lines()
          .next()
          .ok_or_else(|| "Google sign-in callback was empty.".to_string())?;
        let mut segments = request_line.split_whitespace();
        let method = segments.next().unwrap_or_default();
        let target = segments.next().unwrap_or_default();

        if method != "GET" {
          send_http_response(&mut stream, StatusCode::METHOD_NOT_ALLOWED, "Unsupported callback method.");
          continue;
        }

        let callback_url = Url::parse(&format!("http://localhost{target}"))
          .map_err(|error| format!("Failed to parse the Google callback URL: {error}"))?;
        if callback_url.path() != CALLBACK_PATH {
          send_http_response(&mut stream, StatusCode::NOT_FOUND, "Callback path not found.");
          continue;
        }

        if let Some(error) = callback_url.query_pairs().find_map(|(key, value)| {
          (key == "error").then(|| value.into_owned())
        }) {
          send_html_response(
            &mut stream,
            StatusCode::OK,
            "Authentication failed. You can close this window.",
          );
          return Err(format!("Google sign-in failed: {error}"));
        }

        let state = callback_url
          .query_pairs()
          .find_map(|(key, value)| (key == "state").then(|| value.into_owned()));
        let code = callback_url
          .query_pairs()
          .find_map(|(key, value)| (key == "code").then(|| value.into_owned()));

        if state.as_deref() != Some(expected_state) {
          send_http_response(&mut stream, StatusCode::BAD_REQUEST, "The OAuth state did not match.");
          return Err("Google sign-in was rejected because the OAuth state did not match.".to_string());
        }

        let code = code.ok_or_else(|| {
          send_http_response(&mut stream, StatusCode::BAD_REQUEST, "No authorization code was returned.");
          "Google sign-in completed without an authorization code.".to_string()
        })?;

        send_html_response(
          &mut stream,
          StatusCode::OK,
          "Authentication succeeded. You can close this window and return to the app.",
        );
        return Ok(code);
      }
      Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
        std::thread::sleep(Duration::from_millis(100));
      }
      Err(error) => {
        return Err(format!("Google callback listener failed: {error}"));
      }
    }
  }

  Err("Google sign-in timed out before the browser completed authentication.".to_string())
}

fn send_http_response(stream: &mut impl Write, status: StatusCode, message: &str) {
  let _ = write!(
    stream,
    "HTTP/1.1 {} {}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
    status.as_u16(),
    status.canonical_reason().unwrap_or("OK"),
    message.len(),
    message
  );
}

fn send_html_response(stream: &mut impl Write, status: StatusCode, message: &str) {
  let body = format!(
    "<html><body><h1>{message}</h1><p>You can close this window.</p><script>window.close();</script></body></html>"
  );
  let _ = write!(
    stream,
    "HTTP/1.1 {} {}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
    status.as_u16(),
    status.canonical_reason().unwrap_or("OK"),
    body.len(),
    body
  );
}

fn random_urlsafe(bytes: usize) -> String {
  let mut raw = vec![0_u8; bytes];
  rand::thread_rng().fill_bytes(&mut raw);
  URL_SAFE_NO_PAD.encode(raw)
}

fn pkce_challenge(verifier: &str) -> String {
  let digest = Sha256::digest(verifier.as_bytes());
  URL_SAFE_NO_PAD.encode(digest)
}

fn unix_timestamp() -> i64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .unwrap_or_default()
    .as_secs() as i64
}

async fn ensure_code_assist_context(
  client: &reqwest::Client,
  credentials: &mut StoredGoogleCredentials,
) -> Result<String, String> {
  let project_id = active_google_cloud_project()?;
  let metadata = client_metadata(project_id.clone());
  let request = LoadCodeAssistRequest {
    cloudaicompanion_project: project_id.clone(),
    metadata: metadata.clone(),
  };

  let response = client
    .post(format!("{CODE_ASSIST_BASE_URL}:loadCodeAssist"))
    .bearer_auth(&credentials.access_token)
    .header("Content-Type", "application/json")
    .json(&request)
    .send()
    .await
    .map_err(|error| format!("Failed to load the Google Code Assist profile: {error}"))?;

  if !response.status().is_success() {
    return Err(format!(
      "Google Code Assist profile lookup failed: {}",
      read_error_response(response).await
    ));
  }

  let load = response
    .json::<LoadCodeAssistResponse>()
    .await
    .map_err(|error| format!("Failed to parse the Google Code Assist profile: {error}"))?;

  if let Some(current_tier) = &load.current_tier {
    credentials.user_tier = current_tier.id.clone();
    let resolved_project = load
      .cloudaicompanion_project
      .clone()
      .or(project_id.clone())
      .ok_or_else(|| project_requirement_message(&load))?;
    credentials.project_id = Some(resolved_project.clone());
    return Ok(resolved_project);
  }

  let allowed_tier = load
    .allowed_tiers
    .as_ref()
    .and_then(|tiers| tiers.iter().find(|tier| tier.is_default.unwrap_or(false)).cloned())
    .or_else(|| load.allowed_tiers.as_ref().and_then(|tiers| tiers.first().cloned()))
    .ok_or_else(|| project_requirement_message(&load))?;

  let tier_id = allowed_tier
    .id
    .clone()
    .ok_or_else(|| "Google Code Assist did not return an onboarding tier.".to_string())?;

  let onboard_request = OnboardUserRequest {
    tier_id: tier_id.clone(),
    cloudaicompanion_project: if tier_id == "free-tier" {
      None
    } else {
      Some(project_id.clone().ok_or_else(|| project_requirement_message(&load))?)
    },
    metadata: metadata.clone(),
  };

  let onboard_response = client
    .post(format!("{CODE_ASSIST_BASE_URL}:onboardUser"))
    .bearer_auth(&credentials.access_token)
    .header("Content-Type", "application/json")
    .json(&onboard_request)
    .send()
    .await
    .map_err(|error| format!("Failed to start Google Code Assist onboarding: {error}"))?;

  if !onboard_response.status().is_success() {
    return Err(format!(
      "Google Code Assist onboarding failed: {}",
      read_error_response(onboard_response).await
    ));
  }

  let mut operation = onboard_response
    .json::<OperationResponse>()
    .await
    .map_err(|error| format!("Failed to parse the Google Code Assist onboarding response: {error}"))?;

  let operation_name = operation.name.clone();
  let started = Instant::now();
  while !operation.done.unwrap_or(false) {
    if started.elapsed() >= Duration::from_secs(60) {
      return Err("Google Code Assist onboarding timed out.".to_string());
    }

    let name = operation_name
      .clone()
      .ok_or_else(|| "Google Code Assist onboarding did not return an operation name.".to_string())?;
    std::thread::sleep(Duration::from_secs(2));
    let poll_response = client
      .get(format!("{CODE_ASSIST_BASE_URL}/{name}"))
      .bearer_auth(&credentials.access_token)
      .send()
      .await
      .map_err(|error| format!("Failed to poll the Google Code Assist onboarding operation: {error}"))?;

    if !poll_response.status().is_success() {
      return Err(format!(
        "Google Code Assist onboarding polling failed: {}",
        read_error_response(poll_response).await
      ));
    }

    operation = poll_response
      .json::<OperationResponse>()
      .await
      .map_err(|error| format!("Failed to parse the Google Code Assist onboarding operation: {error}"))?;
  }

  credentials.user_tier = Some(tier_id);
  let resolved_project = operation
    .response
    .and_then(|response| response.cloudaicompanion_project)
    .and_then(|project| project.id)
    .or(project_id)
    .ok_or_else(|| project_requirement_message(&load))?;
  credentials.project_id = Some(resolved_project.clone());
  Ok(resolved_project)
}

fn active_google_cloud_project() -> Result<Option<String>, String> {
  let project = PROJECT_ENV_KEYS
    .iter()
    .find_map(|key| std::env::var(key).ok())
    .map(|value| value.trim().to_string())
    .filter(|value| !value.is_empty());

  if let Some(project_id) = &project {
    if project_id.chars().all(|character| character.is_ascii_digit()) {
      return Err(format!(
        "GOOGLE_CLOUD_PROJECT must be a string project ID, not the numeric project number ({project_id})."
      ));
    }
  }

  Ok(project)
}

fn client_metadata(project_id: Option<String>) -> ClientMetadata {
  ClientMetadata {
    ide_type: "IDE_UNSPECIFIED",
    platform: platform_name(),
    plugin_type: "GEMINI",
    duet_project: project_id,
  }
}

fn platform_name() -> &'static str {
  match (std::env::consts::OS, std::env::consts::ARCH) {
    ("macos", "aarch64") => "DARWIN_ARM64",
    ("macos", _) => "DARWIN_AMD64",
    ("windows", _) => "WINDOWS_AMD64",
    ("linux", "aarch64") => "LINUX_ARM64",
    _ => "LINUX_AMD64",
  }
}

fn project_requirement_message(load: &LoadCodeAssistResponse) -> String {
  if let Some(messages) = load.ineligible_tiers.as_ref().map(|tiers| {
    tiers
      .iter()
      .filter_map(|tier| tier.reason_message.clone())
      .collect::<Vec<_>>()
  }) {
    if !messages.is_empty() {
      return messages.join(" ");
    }
  }

  "This Google account needs a Google Cloud project before Code Assist can run. Set GOOGLE_CLOUD_PROJECT and try again.".to_string()
}

async fn read_error_response(response: reqwest::Response) -> String {
  let status = response.status();
  let text = response.text().await.unwrap_or_default();
  if let Ok(payload) = serde_json::from_str::<Value>(&text) {
    if let Some(message) = payload
      .get("error")
      .and_then(|error| error.get("message"))
      .and_then(Value::as_str)
    {
      return format!("{status}: {message}");
    }
    if let Some(message) = payload.get("message").and_then(Value::as_str) {
      return format!("{status}: {message}");
    }
  }

  if text.trim().is_empty() {
    status.to_string()
  } else {
    format!("{status}: {text}")
  }
}

async fn wait_for_code_assist_window() -> Result<(), String> {
  let wait_duration = {
    let mut next_request_at = code_assist_next_request_at()
      .lock()
      .map_err(|_| "Code Assist request state mutex poisoned".to_string())?;
    let now = Instant::now();
    let scheduled_start = next_request_at.unwrap_or(now);
    let wait_duration = scheduled_start.saturating_duration_since(now);
    *next_request_at = Some(scheduled_start.max(now) + CODE_ASSIST_MIN_REQUEST_SPACING);
    wait_duration
  };

  if !wait_duration.is_zero() {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(wait_duration)).await;
  }

  Ok(())
}

fn update_code_assist_cooldown(delay: Duration) -> Result<(), String> {
  let mut next_request_at = code_assist_next_request_at()
    .lock()
    .map_err(|_| "Code Assist request state mutex poisoned".to_string())?;
  let proposed_time = Instant::now() + delay;
  if next_request_at.map(|current| current < proposed_time).unwrap_or(true) {
    *next_request_at = Some(proposed_time);
  }
  Ok(())
}

fn fallback_retry_delay(attempt: usize) -> Duration {
  let multiplier = 2_u32.saturating_pow(attempt as u32);
  CODE_ASSIST_FALLBACK_RETRY_DELAY.saturating_mul(multiplier)
}

fn parse_retry_after_seconds(value: &str) -> Option<f64> {
  value.trim().parse::<f64>().ok().filter(|seconds| *seconds >= 0.0)
}

fn parse_code_assist_retry_delay(error_message: &str) -> Option<Duration> {
  let normalized = error_message.to_lowercase();
  for marker in ["please retry in ", "quota will reset after ", "retry after "] {
    if let Some(index) = normalized.find(marker) {
      let start = index + marker.len();
      let token = error_message[start..]
        .chars()
        .take_while(|character| character.is_ascii_digit() || matches!(character, '.' | 'h' | 'm' | 's'))
        .collect::<String>();
      if let Some(seconds) = parse_duration_token(&token) {
        return Some(Duration::from_secs_f64(seconds));
      }
    }
  }

  None
}

fn parse_duration_token(token: &str) -> Option<f64> {
  if token.is_empty() {
    return None;
  }

  let mut index = 0;
  let mut total_seconds = 0.0;
  let mut matched_segment = false;
  let bytes = token.as_bytes();

  while index < bytes.len() {
    let number_start = index;
    while index < bytes.len() && (bytes[index].is_ascii_digit() || bytes[index] == b'.') {
      index += 1;
    }

    if number_start == index {
      return matched_segment.then_some(total_seconds);
    }

    let value = token[number_start..index].parse::<f64>().ok()?;
    let remaining = &token[index..];

    if remaining.starts_with("ms") {
      total_seconds += value / 1000.0;
      index += 2;
    } else if remaining.starts_with('h') {
      total_seconds += value * 3600.0;
      index += 1;
    } else if remaining.starts_with('m') {
      total_seconds += value * 60.0;
      index += 1;
    } else if remaining.starts_with('s') {
      total_seconds += value;
      index += 1;
    } else {
      return None;
    }

    matched_segment = true;
  }

  matched_segment.then_some(total_seconds)
}

fn extract_generated_text(payload: &Value) -> Option<String> {
  let parts = payload
    .get("response")
    .and_then(|response| response.get("candidates"))
    .and_then(Value::as_array)?
    .first()?
    .get("content")
    .and_then(|content| content.get("parts"))
    .and_then(Value::as_array)?;

  let text = parts
    .iter()
    .filter_map(|part| part.get("text").and_then(Value::as_str))
    .collect::<Vec<_>>()
    .join("");

  (!text.trim().is_empty()).then_some(text)
}
