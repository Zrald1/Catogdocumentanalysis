use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use uuid::Uuid;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeBaseConfig {
  pub id: String,
  pub name: String,
  pub url: Option<String>,
  pub api_key: Option<String>,
  pub collection_name: Option<String>,
  pub graph_url: Option<String>,
  pub graph_name: Option<String>,
  pub embedder_provider: Option<String>,
  pub embedding_model: Option<String>,
  pub embedding_api_key: Option<String>,
  pub embedding_base_url: Option<String>,
  pub search_min_score: Option<f64>,
  pub search_max_results: Option<usize>,
  pub chunk_size: Option<usize>,
  pub overlap: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeBaseSearchResult {
  pub id: String,
  pub knowledge_base_id: String,
  pub knowledge_base_name: String,
  pub score: f64,
  pub content: String,
  pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeBaseConnectionTestResult {
  pub provider: String,
  pub model: String,
  pub collection_name: String,
  pub vector_matches: usize,
  pub message: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeBaseIngestionDocument {
  pub file_name: String,
  pub content: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeBaseIngestionResult {
  pub ingested_files: usize,
  pub chunk_count: usize,
  pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeBaseIndexedDocument {
  pub file_name: String,
  pub chunk_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeBaseDeleteDocumentsResult {
  pub deleted_files: Vec<String>,
  pub deleted_points: usize,
  pub message: String,
}

pub async fn query_knowledge_base(
  config: KnowledgeBaseConfig,
  query: String,
  limit: Option<usize>,
) -> Result<Vec<KnowledgeBaseSearchResult>, String> {
  if query.trim().is_empty() {
    return Ok(vec![]);
  }

  let qdrant_url = require_non_empty(config.url.clone(), "Qdrant URL is required")?;
  let collection_name = require_non_empty(config.collection_name.clone(), "Qdrant collection name is required")?;
  let embedder_provider = config
    .embedder_provider
    .clone()
    .unwrap_or_else(|| "gemini".to_string());
  let embedding_api_key = resolve_embedding_api_key(&embedder_provider, &config)?;

  let client = Client::new();
  let embedding = create_embedding(
    &client,
    &embedder_provider,
    &embedding_api_key,
    config.embedding_base_url.clone(),
    config.embedding_model.clone(),
    query.trim(),
  )
  .await?;

  search_qdrant(
    &client,
    &config,
    &qdrant_url,
    &collection_name,
    embedding,
    limit.unwrap_or(config.search_max_results.unwrap_or(5)),
  )
  .await
}

pub async fn test_knowledge_base_connection(
  config: KnowledgeBaseConfig,
) -> Result<KnowledgeBaseConnectionTestResult, String> {
  let qdrant_url = require_non_empty(config.url.clone(), "Qdrant URL is required")?;
  let collection_name = require_non_empty(config.collection_name.clone(), "Qdrant collection name is required")?;
  let provider = config
    .embedder_provider
    .clone()
    .unwrap_or_else(|| "gemini".to_string());
  let resolved_model = resolve_embedding_model(&provider, config.embedding_model.as_deref());
  let embedding_api_key = resolve_embedding_api_key(&provider, &config)?;

  let client = Client::new();
  let embedding = create_embedding(
    &client,
    &provider,
    &embedding_api_key,
    config.embedding_base_url.clone(),
    Some(resolved_model.clone()),
    "connection validation query",
  )
  .await?;
  ensure_qdrant_collection(&client, &config, &qdrant_url, &collection_name, embedding.len()).await?;
  let vector_matches = query_qdrant_points(&client, &config, &qdrant_url, &collection_name, embedding, 1)
    .await?
    .len();

  Ok(KnowledgeBaseConnectionTestResult {
    provider: provider.clone(),
    model: resolved_model.clone(),
    collection_name: collection_name.clone(),
    vector_matches,
    message: format!(
      "Connected successfully. Provider: {provider}. Model: {resolved_model}. Collection: {collection_name}. Query returned {vector_matches} match(es)."
    ),
  })
}

pub async fn ingest_knowledge_base_files(
  config: KnowledgeBaseConfig,
  documents: Vec<KnowledgeBaseIngestionDocument>,
) -> Result<KnowledgeBaseIngestionResult, String> {
  if documents.is_empty() {
    return Err("Select at least one file to ingest.".to_string());
  }

  let qdrant_url = require_non_empty(config.url.clone(), "Qdrant URL is required")?;
  let collection_name = require_non_empty(config.collection_name.clone(), "Qdrant collection name is required")?;
  let provider = config
    .embedder_provider
    .clone()
    .unwrap_or_else(|| "gemini".to_string());
  let resolved_model = resolve_embedding_model(&provider, config.embedding_model.as_deref());
  let embedding_api_key = resolve_embedding_api_key(&provider, &config)?;
  let client = Client::new();
  let chunk_size = config.chunk_size.unwrap_or(500).max(100);
  let overlap_percent = config.overlap.unwrap_or(10).min(90);

  let mut points: Vec<Value> = Vec::new();

  for (document_index, document) in documents.iter().enumerate() {
    let chunks = chunk_document(&document.content, chunk_size, overlap_percent);
    if chunks.is_empty() {
      continue;
    }

    let embeddings = create_embeddings(
      &client,
      &provider,
      &embedding_api_key,
      config.embedding_base_url.clone(),
      Some(resolved_model.clone()),
      chunks.clone(),
      false,
    )
    .await?;

    for (chunk_index, (chunk, embedding)) in chunks.into_iter().zip(embeddings.into_iter()).enumerate() {
      let point_id = Uuid::new_v5(
        &Uuid::NAMESPACE_URL,
        format!("{collection_name}:{}:{document_index}:{chunk_index}", document.file_name).as_bytes(),
      );
      points.push(json!({
        "id": point_id.to_string(),
        "vector": embedding,
        "payload": {
          "content": chunk,
          "source": document.file_name,
          "fileName": document.file_name,
          "chunkIndex": chunk_index,
        }
      }));
    }
  }

  if points.is_empty() {
    return Err("No usable file content was extracted for ingestion.".to_string());
  }

  let vector_size = points
    .first()
    .and_then(|point| point.get("vector"))
    .and_then(Value::as_array)
    .map(|vector| vector.len())
    .ok_or_else(|| "Generated embeddings did not contain vector values.".to_string())?;

  ensure_qdrant_collection(&client, &config, &qdrant_url, &collection_name, vector_size).await?;
  upsert_qdrant_points(&client, &config, &qdrant_url, &collection_name, points).await?;

  Ok(KnowledgeBaseIngestionResult {
    ingested_files: documents.len(),
    chunk_count: vector_size.saturating_sub(vector_size) + points_count(&collection_name, &resolved_model, &provider, &documents, &config),
    message: format!(
      "Uploaded {} file(s) into {} using {} / {}.",
      documents.len(),
      collection_name,
      provider,
      resolved_model
    ),
  })
}

pub async fn list_knowledge_base_documents(
  config: KnowledgeBaseConfig,
) -> Result<Vec<KnowledgeBaseIndexedDocument>, String> {
  let qdrant_url = require_non_empty(config.url.clone(), "Qdrant URL is required")?;
  let collection_name = require_non_empty(config.collection_name.clone(), "Qdrant collection name is required")?;
  let client = Client::new();
  let points = scroll_qdrant_points(&client, &config, &qdrant_url, &collection_name, None).await?;
  let mut documents = BTreeMap::<String, usize>::new();

  for point in points {
    let payload = match point.get("payload") {
      Some(payload) => payload,
      None => continue,
    };

    let file_name = extract_string_from_keys(payload, &["fileName", "source"])
      .unwrap_or_else(|| "unknown".to_string());
    *documents.entry(file_name).or_default() += 1;
  }

  Ok(documents
    .into_iter()
    .map(|(file_name, chunk_count)| KnowledgeBaseIndexedDocument { file_name, chunk_count })
    .collect())
}

pub async fn delete_knowledge_base_documents(
  config: KnowledgeBaseConfig,
  file_names: Vec<String>,
) -> Result<KnowledgeBaseDeleteDocumentsResult, String> {
  let filtered_file_names = file_names
    .into_iter()
    .map(|file_name| file_name.trim().to_string())
    .filter(|file_name| !file_name.is_empty())
    .collect::<Vec<_>>();

  if filtered_file_names.is_empty() {
    return Err("Select at least one embedded file to delete.".to_string());
  }

  let qdrant_url = require_non_empty(config.url.clone(), "Qdrant URL is required")?;
  let collection_name = require_non_empty(config.collection_name.clone(), "Qdrant collection name is required")?;
  let client = Client::new();
  let filter = build_file_name_filter(&filtered_file_names);
  let points_to_delete = scroll_qdrant_points(&client, &config, &qdrant_url, &collection_name, Some(filter.clone())).await?;
  let deleted_points = points_to_delete.len();

  let endpoint = build_endpoint(&qdrant_url, &format!("collections/{collection_name}/points/delete"))?;
  let mut request = client.post(endpoint).json(&json!({
    "filter": filter,
    "wait": true,
  }));

  if let Some(api_key) = config.api_key.as_deref().filter(|value| !value.trim().is_empty()) {
    request = request.header("api-key", api_key);
  }

  let response = request
    .send()
    .await
    .map_err(|error| format!("Failed to delete Qdrant points: {error}"))?;

  if !response.status().is_success() {
    let body: Value = response
      .json()
      .await
      .unwrap_or_else(|_| json!({ "error": "Unable to decode Qdrant delete response" }));
    return Err(format!("Failed to delete Qdrant points: {}", body));
  }

  Ok(KnowledgeBaseDeleteDocumentsResult {
    deleted_files: filtered_file_names.clone(),
    deleted_points,
    message: format!(
      "Deleted {} embedded file(s) and {} point(s) from {}.",
      filtered_file_names.len(),
      deleted_points,
      collection_name,
    ),
  })
}

async fn create_embedding(
  client: &Client,
  provider: &str,
  api_key: &str,
  base_url: Option<String>,
  embedding_model: Option<String>,
  query: &str,
) -> Result<Vec<f64>, String> {
  let mut embeddings = create_embeddings(
    client,
    provider,
    api_key,
    base_url,
    embedding_model,
    vec![query.to_string()],
    true,
  )
  .await?;

  embeddings
    .pop()
    .ok_or_else(|| "Embedding response did not contain a vector".to_string())
}

async fn create_embeddings(
  client: &Client,
  provider: &str,
  api_key: &str,
  base_url: Option<String>,
  embedding_model: Option<String>,
  inputs: Vec<String>,
  is_query: bool,
) -> Result<Vec<Vec<f64>>, String> {
  let model = resolve_embedding_model(provider, embedding_model.as_deref());
  let prepared_inputs = prepare_embedding_inputs(provider, &model, inputs, is_query);

  let endpoint = match provider {
    "gemini" => build_endpoint("https://generativelanguage.googleapis.com/v1beta/openai/", "embeddings")?,
    "openai" => build_endpoint("https://api.openai.com/v1/", "embeddings")?,
    "openai-compatible" => {
      let custom_base_url = require_non_empty(base_url, "Embedding base URL is required for OpenAI-compatible providers")?;
      build_endpoint(&custom_base_url, "embeddings")?
    }
    unsupported_provider => {
      return Err(format!("Unsupported embedding provider: {unsupported_provider}"));
    }
  };

  let request = client
    .post(endpoint);
  let request = if api_key.trim().is_empty() {
    request
  } else {
    request.bearer_auth(api_key)
  };

  let response = request
    .json(&json!({
      "model": model,
      "input": prepared_inputs,
    }))
    .send()
    .await
    .map_err(|error| format!("Failed to request embeddings: {error}"))?;

  let status = response.status();
  let body: Value = response
    .json()
    .await
    .map_err(|error| format!("Failed to decode embedding response: {error}"))?;

  if !status.is_success() {
    return Err(format!(
      "Embedding request failed with status {}: {}",
      status,
      body
    ));
  }

  let embeddings = body
    .get("data")
    .and_then(Value::as_array)
    .ok_or_else(|| "Embedding response did not contain vectors".to_string())?;

  embeddings
    .iter()
    .map(|embedding| {
      embedding
        .get("embedding")
        .and_then(Value::as_array)
        .ok_or_else(|| "Embedding response contained an invalid vector".to_string())?
        .iter()
        .map(|value| {
          value
            .as_f64()
            .ok_or_else(|| "Embedding response contained a non-numeric value".to_string())
        })
        .collect()
    })
    .collect()
}

fn resolve_embedding_api_key(provider: &str, config: &KnowledgeBaseConfig) -> Result<String, String> {
  if provider == "openai-compatible" {
    return Ok(config.embedding_api_key.clone().unwrap_or_default().trim().to_string());
  }

  require_non_empty(
    config.embedding_api_key.clone(),
    "Embedding API key is required for the selected provider",
  )
}

fn prepare_embedding_inputs(
  provider: &str,
  model: &str,
  inputs: Vec<String>,
  is_query: bool,
) -> Vec<String> {
  if provider == "openai-compatible" && model.starts_with("nomic-embed-text-v1.5") {
    let prefix = if is_query { "search_query: " } else { "search_document: " };
    return inputs
      .into_iter()
      .map(|input| {
        if input.trim_start().starts_with("search_query:") || input.trim_start().starts_with("search_document:") {
          input
        } else {
          format!("{prefix}{input}")
        }
      })
      .collect();
  }

  inputs
}

async fn search_qdrant(
  client: &Client,
  config: &KnowledgeBaseConfig,
  qdrant_url: &str,
  collection_name: &str,
  embedding: Vec<f64>,
  limit: usize,
) -> Result<Vec<KnowledgeBaseSearchResult>, String> {
  let points = query_qdrant_points(client, config, qdrant_url, collection_name, embedding, limit).await?;

  Ok(points
    .into_iter()
    .filter_map(|point| map_search_result(config, &point))
    .collect())
}

async fn get_qdrant_collection(
  client: &Client,
  config: &KnowledgeBaseConfig,
  qdrant_url: &str,
  collection_name: &str,
) -> Result<Value, String> {
  let endpoint = build_endpoint(qdrant_url, &format!("collections/{collection_name}"))?;
  let mut request = client.get(endpoint);

  if let Some(api_key) = config.api_key.as_deref().filter(|value| !value.trim().is_empty()) {
    request = request.header("api-key", api_key);
  }

  let response = request
    .send()
    .await
    .map_err(|error| format!("Failed to query Qdrant collection info: {error}"))?;

  let status = response.status();
  let body: Value = response
    .json()
    .await
    .map_err(|error| format!("Failed to decode Qdrant collection response: {error}"))?;

  if !status.is_success() {
    return Err(format!(
      "Qdrant collection request failed with status {}: {}",
      status,
      body
    ));
  }

  Ok(body)
}

async fn query_qdrant_points(
  client: &Client,
  config: &KnowledgeBaseConfig,
  qdrant_url: &str,
  collection_name: &str,
  embedding: Vec<f64>,
  limit: usize,
) -> Result<Vec<Value>, String> {
  let endpoint = build_endpoint(qdrant_url, &format!("collections/{collection_name}/points/query"))?;
  let mut request = client.post(endpoint).json(&json!({
    "query": embedding,
    "limit": limit,
    "score_threshold": config.search_min_score.unwrap_or(0.4),
    "with_payload": true,
  }));

  if let Some(api_key) = config.api_key.as_deref().filter(|value| !value.trim().is_empty()) {
    request = request.header("api-key", api_key);
  }

  let response = request
    .send()
    .await
    .map_err(|error| format!("Failed to query Qdrant: {error}"))?;

  let status = response.status();
  let body: Value = response
    .json()
    .await
    .map_err(|error| format!("Failed to decode Qdrant response: {error}"))?;

  if !status.is_success() {
    return Err(format!(
      "Qdrant query failed with status {}: {}",
      status,
      body
    ));
  }

  Ok(body
    .get("result")
    .and_then(|result| result.get("points").or_else(|| Some(result)))
    .and_then(Value::as_array)
    .cloned()
    .unwrap_or_default())
}

async fn ensure_qdrant_collection(
  client: &Client,
  config: &KnowledgeBaseConfig,
  qdrant_url: &str,
  collection_name: &str,
  vector_size: usize,
) -> Result<(), String> {
  match get_qdrant_collection(client, config, qdrant_url, collection_name).await {
    Ok(collection) => {
      let existing_vector_size = collection
        .get("result")
        .and_then(|result| result.get("config"))
        .and_then(|config| config.get("params"))
        .and_then(|params| params.get("vectors"))
        .and_then(|vectors| vectors.get("size").or_else(|| Some(vectors)))
        .and_then(Value::as_u64);

      if let Some(existing_vector_size) = existing_vector_size {
        if existing_vector_size as usize != vector_size {
          return Err(format!(
            "Collection {} exists with vector size {}, but the selected embedding model produces {} dimensions.",
            collection_name,
            existing_vector_size,
            vector_size
          ));
        }
      }

      Ok(())
    }
    Err(_) => {
      let endpoint = build_endpoint(qdrant_url, &format!("collections/{collection_name}"))?;
      let mut request = client.put(endpoint).json(&json!({
        "vectors": {
          "size": vector_size,
          "distance": "Cosine"
        }
      }));

      if let Some(api_key) = config.api_key.as_deref().filter(|value| !value.trim().is_empty()) {
        request = request.header("api-key", api_key);
      }

      let response = request
        .send()
        .await
        .map_err(|error| format!("Failed to create Qdrant collection: {error}"))?;

      if !response.status().is_success() {
        let body: Value = response
          .json()
          .await
          .unwrap_or_else(|_| json!({ "error": "Unable to decode Qdrant collection creation response" }));
        return Err(format!("Failed to create Qdrant collection: {}", body));
      }

      Ok(())
    }
  }
}

async fn upsert_qdrant_points(
  client: &Client,
  config: &KnowledgeBaseConfig,
  qdrant_url: &str,
  collection_name: &str,
  points: Vec<Value>,
) -> Result<(), String> {
  let endpoint = build_endpoint(qdrant_url, &format!("collections/{collection_name}/points"))?;
  let mut request = client.put(endpoint).json(&json!({
    "points": points,
    "wait": true,
  }));

  if let Some(api_key) = config.api_key.as_deref().filter(|value| !value.trim().is_empty()) {
    request = request.header("api-key", api_key);
  }

  let response = request
    .send()
    .await
    .map_err(|error| format!("Failed to upsert Qdrant points: {error}"))?;

  if !response.status().is_success() {
    let body: Value = response
      .json()
      .await
      .unwrap_or_else(|_| json!({ "error": "Unable to decode Qdrant upsert response" }));
    return Err(format!("Failed to upsert Qdrant points: {}", body));
  }

  Ok(())
}

async fn scroll_qdrant_points(
  client: &Client,
  config: &KnowledgeBaseConfig,
  qdrant_url: &str,
  collection_name: &str,
  filter: Option<Value>,
) -> Result<Vec<Value>, String> {
  let endpoint = build_endpoint(qdrant_url, &format!("collections/{collection_name}/points/scroll"))?;
  let mut request_body = json!({
    "limit": 1000,
    "with_payload": true,
    "with_vectors": false,
  });

  if let Some(filter) = filter {
    request_body["filter"] = filter;
  }

  let mut request = client.post(endpoint).json(&request_body);

  if let Some(api_key) = config.api_key.as_deref().filter(|value| !value.trim().is_empty()) {
    request = request.header("api-key", api_key);
  }

  let response = request
    .send()
    .await
    .map_err(|error| format!("Failed to list Qdrant points: {error}"))?;

  let status = response.status();
  let body: Value = response
    .json()
    .await
    .map_err(|error| format!("Failed to decode Qdrant scroll response: {error}"))?;

  if !status.is_success() {
    return Err(format!("Failed to list Qdrant points: {}", body));
  }

  Ok(body
    .get("result")
    .and_then(|result| result.get("points").or_else(|| Some(result)))
    .and_then(Value::as_array)
    .cloned()
    .unwrap_or_default())
}

fn map_search_result(config: &KnowledgeBaseConfig, point: &Value) -> Option<KnowledgeBaseSearchResult> {
  let payload = point.get("payload")?;
  let content = extract_content(payload)?;
  let source = extract_source(payload);

  Some(KnowledgeBaseSearchResult {
    id: stringify_value(point.get("id")).unwrap_or_else(|| "unknown".to_string()),
    knowledge_base_id: config.id.clone(),
    knowledge_base_name: config.name.clone(),
    score: point.get("score").and_then(Value::as_f64).unwrap_or_default(),
    content: truncate_string(&content, 1200),
    source,
  })
}

fn extract_content(payload: &Value) -> Option<String> {
  extract_string_from_keys(
    payload,
    &[
      "content",
      "text",
      "chunk",
      "page_content",
      "document",
      "codeChunk",
      "body",
      "summary",
      "snippet",
    ],
  )
  .or_else(|| extract_string_from_nested_object(payload, "metadata", &["content", "text", "summary", "snippet"]))
}

fn extract_source(payload: &Value) -> Option<String> {
  extract_string_from_keys(
    payload,
    &["source", "filePath", "path", "title", "documentName", "name", "url"],
  )
  .or_else(|| extract_string_from_nested_object(payload, "metadata", &["source", "path", "title", "documentName"]))
}

fn extract_string_from_keys(payload: &Value, keys: &[&str]) -> Option<String> {
  keys.iter().find_map(|key| stringify_value(payload.get(*key)))
}

fn extract_string_from_nested_object(payload: &Value, object_key: &str, keys: &[&str]) -> Option<String> {
  payload
    .get(object_key)
    .and_then(|value| keys.iter().find_map(|key| stringify_value(value.get(*key))))
}

fn stringify_value(value: Option<&Value>) -> Option<String> {
  let value = value?;

  match value {
    Value::String(text) => Some(text.to_string()),
    Value::Number(number) => Some(number.to_string()),
    Value::Bool(boolean) => Some(boolean.to_string()),
    _ => None,
  }
}

fn truncate_string(value: &str, max_chars: usize) -> String {
  value.chars().take(max_chars).collect()
}

fn build_file_name_filter(file_names: &[String]) -> Value {
  json!({
    "should": file_names
      .iter()
      .map(|file_name| {
        json!({
          "key": "fileName",
          "match": {
            "value": file_name,
          }
        })
      })
      .collect::<Vec<_>>()
  })
}

fn chunk_document(content: &str, chunk_size: usize, overlap_percent: usize) -> Vec<String> {
  if content.trim().is_empty() {
    return Vec::new();
  }

  let characters: Vec<char> = content.chars().collect();
  let overlap_size = ((chunk_size as f64) * (overlap_percent as f64 / 100.0)).round() as usize;
  let step = chunk_size.saturating_sub(overlap_size).max(1);

  let mut chunks = Vec::new();
  let mut start = 0;

  while start < characters.len() {
    let end = (start + chunk_size).min(characters.len());
    let chunk = characters[start..end].iter().collect::<String>().trim().to_string();

    if !chunk.is_empty() {
      chunks.push(chunk);
    }

    if end == characters.len() {
      break;
    }

    start += step;
  }

  chunks
}

fn points_count(
  _collection_name: &str,
  _resolved_model: &str,
  _provider: &str,
  documents: &[KnowledgeBaseIngestionDocument],
  config: &KnowledgeBaseConfig,
) -> usize {
  documents
    .iter()
    .map(|document| chunk_document(&document.content, config.chunk_size.unwrap_or(500).max(100), config.overlap.unwrap_or(10).min(90)).len())
    .sum()
}

fn require_non_empty(value: Option<String>, message: &str) -> Result<String, String> {
  let value = value.unwrap_or_default();
  let trimmed_value = value.trim();

  if trimmed_value.is_empty() {
    return Err(message.to_string());
  }

  Ok(trimmed_value.to_string())
}

fn build_endpoint(base_url: &str, path: &str) -> Result<Url, String> {
  let normalized_base_url = normalize_url(base_url);
  let base = if normalized_base_url.ends_with('/') {
    normalized_base_url
  } else {
    format!("{normalized_base_url}/")
  };

  let parsed_url = Url::parse(&base).map_err(|error| format!("Invalid URL '{base}': {error}"))?;
  parsed_url
    .join(path)
    .map_err(|error| format!("Failed to build endpoint for '{path}': {error}"))
}

fn normalize_url(url: &str) -> String {
  let trimmed_url = url.trim();
  if trimmed_url.starts_with("http://") || trimmed_url.starts_with("https://") {
    trimmed_url.to_string()
  } else {
    format!("http://{trimmed_url}")
  }
}

fn resolve_embedding_model(provider: &str, embedding_model: Option<&str>) -> String {
  let embedding_model = embedding_model.unwrap_or_default().trim();

  if provider == "gemini" && (embedding_model.is_empty() || embedding_model == "text-embedding-004") {
    return "gemini-embedding-001".to_string();
  }

  if embedding_model.is_empty() {
    return match provider {
      "gemini" => "gemini-embedding-001",
      "openai" | "openai-compatible" => "text-embedding-3-small",
      _ => "gemini-embedding-001",
    }
    .to_string();
  }

  embedding_model.to_string()
}
