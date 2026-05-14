use redis::{aio::MultiplexedConnection, Client as RedisClient, Value as RedisValue};
use serde::{Deserialize, Serialize};

use crate::knowledge_base::KnowledgeBaseConfig;

const MAX_GRAPH_FILE_NAME_CHARS: usize = 160;
const MAX_GRAPH_LABEL_CHARS: usize = 96;
const MAX_GRAPH_KIND_CHARS: usize = 32;
const MAX_GRAPH_DESCRIPTION_CHARS: usize = 280;
const MAX_GRAPH_EVIDENCE_CHARS: usize = 360;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeGraphDocumentNodeInput {
  pub id: String,
  pub label: String,
  pub kind: String,
  pub description: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeGraphDocumentLinkInput {
  pub source: String,
  pub target: String,
  pub label: String,
  pub description: Option<String>,
  pub evidence: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeGraphDocumentInput {
  pub document_id: String,
  pub file_name: String,
  pub scope: String,
  pub source_document_id: String,
  pub nodes: Vec<KnowledgeGraphDocumentNodeInput>,
  pub links: Vec<KnowledgeGraphDocumentLinkInput>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeGraphNode {
  pub id: String,
  pub label: String,
  pub kind: String,
  pub kb_id: String,
  pub scope: String,
  pub source_file: Option<String>,
  pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeGraphLink {
  pub id: String,
  pub source: String,
  pub target: String,
  pub label: String,
  pub kb_id: String,
  pub scope: String,
  pub source_file: Option<String>,
  pub description: Option<String>,
  pub evidence: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeGraphData {
  pub graph_name: String,
  pub knowledge_base_id: String,
  pub knowledge_base_name: String,
  pub scope: String,
  pub source_document_id: Option<String>,
  pub source_file: Option<String>,
  pub nodes: Vec<KnowledgeGraphNode>,
  pub links: Vec<KnowledgeGraphLink>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeGraphConnectionTestResult {
  pub graph_name: String,
  pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeGraphIngestionResult {
  pub graph_name: String,
  pub source_document_id: String,
  pub node_count: usize,
  pub edge_count: usize,
  pub message: String,
}

pub async fn test_knowledge_graph_connection(
  config: KnowledgeBaseConfig,
) -> Result<KnowledgeGraphConnectionTestResult, String> {
  let graph_url = require_non_empty(config.graph_url.clone(), "FalkorDB URL is required")?;
  let graph_name = require_non_empty(config.graph_name.clone(), "FalkorDB graph name is required")?;

  let mut connection = open_graph_connection(&graph_url).await?;
  let healthcheck_result = run_graph_query(&mut connection, &graph_name, "RETURN 1", true).await;
  if let Err(error) = healthcheck_result {
    if !error.contains("empty key") {
      return Err(error);
    }
  }

  Ok(KnowledgeGraphConnectionTestResult {
    graph_name: graph_name.clone(),
    message: format!("FalkorDB connected successfully. Graph: {graph_name}."),
  })
}

pub async fn ingest_knowledge_graph_document(
  config: KnowledgeBaseConfig,
  document: KnowledgeGraphDocumentInput,
) -> Result<KnowledgeGraphIngestionResult, String> {
  let graph_url = require_non_empty(config.graph_url.clone(), "FalkorDB URL is required")?;
  let graph_name = require_non_empty(config.graph_name.clone(), "FalkorDB graph name is required")?;

  if document.nodes.is_empty() {
    return Err("At least one graph node is required for graph ingestion.".to_string());
  }

  let mut connection = open_graph_connection(&graph_url).await?;
  remove_existing_document_graph(&mut connection, &graph_name, &document).await?;
  let file_name = truncate_graph_text(&document.file_name, MAX_GRAPH_FILE_NAME_CHARS);

  if document.scope == "knowledge-base" {
    let kb_root_id = format!("kb:{}", sanitize_identifier(&config.id));
    let root_query = format!(
      "MERGE (kb:KnowledgeBase {{id: '{}'}}) SET kb.label = '{}', kb.kind = 'knowledge-base', kb.knowledgeBaseId = '{}', kb.scope = 'knowledge-base'",
      escape_cypher_string(&kb_root_id),
      escape_cypher_string(&config.name),
      escape_cypher_string(&config.id),
    );
    run_graph_query(&mut connection, &graph_name, &root_query, false).await?;
  }

  let document_query = format!(
    "MERGE (doc:Document {{id: '{document_id}'}}) SET doc.label = '{file_name}', doc.kind = 'document', doc.knowledgeBaseId = '{knowledge_base_id}', doc.scope = '{scope}', doc.sourceDocumentId = '{source_document_id}', doc.sourceFile = '{file_name}', doc.description = 'Indexed {scope} document'",
    document_id = escape_cypher_string(&document.document_id),
    file_name = escape_cypher_string(&file_name),
    knowledge_base_id = escape_cypher_string(&config.id),
    scope = escape_cypher_string(&document.scope),
    source_document_id = escape_cypher_string(&document.source_document_id),
  );
  run_graph_query(&mut connection, &graph_name, &document_query, false).await?;

  if document.scope == "knowledge-base" {
    let kb_root_id = format!("kb:{}", sanitize_identifier(&config.id));
    let root_edge_query = format!(
      "MATCH (kb:KnowledgeBase {{id: '{kb_root_id}'}}), (doc:Document {{id: '{document_id}'}}) MERGE (kb)-[:HAS_DOCUMENT {{documentId: '{source_document_id}'}}]->(doc)",
      kb_root_id = escape_cypher_string(&kb_root_id),
      document_id = escape_cypher_string(&document.document_id),
      source_document_id = escape_cypher_string(&document.source_document_id),
    );
    run_graph_query(&mut connection, &graph_name, &root_edge_query, false).await?;
  }

  for node in &document.nodes {
    let label = truncate_graph_text(&node.label, MAX_GRAPH_LABEL_CHARS);
    let kind = truncate_graph_text(&node.kind, MAX_GRAPH_KIND_CHARS);
    let description = truncate_graph_text(
      node.description.as_deref().unwrap_or(""),
      MAX_GRAPH_DESCRIPTION_CHARS,
    );
    let node_query = format!(
      "MERGE (n:KnowledgeNode {{id: '{node_id}'}}) SET n.label = '{label}', n.kind = '{kind}', n.knowledgeBaseId = '{knowledge_base_id}', n.scope = '{scope}', n.sourceDocumentId = '{source_document_id}', n.sourceFile = '{source_file}', n.description = '{description}'",
      node_id = escape_cypher_string(&node.id),
      label = escape_cypher_string(&label),
      kind = escape_cypher_string(&kind),
      knowledge_base_id = escape_cypher_string(&config.id),
      scope = escape_cypher_string(&document.scope),
      source_document_id = escape_cypher_string(&document.source_document_id),
      source_file = escape_cypher_string(&file_name),
      description = escape_cypher_string(&description),
    );
    run_graph_query(&mut connection, &graph_name, &node_query, false).await?;

    let mention_query = format!(
      "MATCH (doc:Document {{id: '{document_id}'}}), (n:KnowledgeNode {{id: '{node_id}'}}) MERGE (doc)-[:MENTIONS {{documentId: '{source_document_id}', sourceFile: '{source_file}'}}]->(n)",
      document_id = escape_cypher_string(&document.document_id),
      node_id = escape_cypher_string(&node.id),
      source_document_id = escape_cypher_string(&document.source_document_id),
      source_file = escape_cypher_string(&file_name),
    );
    run_graph_query(&mut connection, &graph_name, &mention_query, false).await?;
  }

  for link in &document.links {
    let relationship_type = sanitize_relationship_label(&link.label);
    let description = truncate_graph_text(
      link.description.as_deref().unwrap_or(""),
      MAX_GRAPH_DESCRIPTION_CHARS,
    );
    let evidence = truncate_graph_text(
      link.evidence.as_deref().unwrap_or(""),
      MAX_GRAPH_EVIDENCE_CHARS,
    );
    let link_query = format!(
      "MATCH (source {{id: '{source_id}'}}), (target {{id: '{target_id}'}}) MERGE (source)-[r:{relationship_type} {{documentId: '{source_document_id}'}}]->(target) SET r.description = '{description}', r.evidence = '{evidence}', r.sourceFile = '{source_file}', r.scope = '{scope}', r.knowledgeBaseId = '{knowledge_base_id}'",
      source_id = escape_cypher_string(&link.source),
      target_id = escape_cypher_string(&link.target),
      relationship_type = relationship_type,
      source_document_id = escape_cypher_string(&document.source_document_id),
      description = escape_cypher_string(&description),
      evidence = escape_cypher_string(&evidence),
      source_file = escape_cypher_string(&file_name),
      scope = escape_cypher_string(&document.scope),
      knowledge_base_id = escape_cypher_string(&config.id),
    );
    run_graph_query(&mut connection, &graph_name, &link_query, false).await?;
  }

  cleanup_orphaned_nodes(&mut connection, &graph_name, &config.id, &document.scope).await?;

  Ok(KnowledgeGraphIngestionResult {
    graph_name: graph_name.clone(),
    source_document_id: document.source_document_id.clone(),
    node_count: document.nodes.len() + 1,
    edge_count: document.links.len() + document.nodes.len() + usize::from(document.scope == "knowledge-base"),
    message: format!(
      "Indexed {} node(s) and {} edge(s) into FalkorDB graph {} for {}.",
      document.nodes.len() + 1,
      document.links.len() + document.nodes.len() + usize::from(document.scope == "knowledge-base"),
      graph_name,
      file_name
    ),
  })
}

pub async fn query_knowledge_graph(
  config: KnowledgeBaseConfig,
  scope: String,
  source_document_id: Option<String>,
) -> Result<KnowledgeGraphData, String> {
  let graph_url = require_non_empty(config.graph_url.clone(), "FalkorDB URL is required")?;
  let graph_name = require_non_empty(config.graph_name.clone(), "FalkorDB graph name is required")?;
  let mut connection = open_graph_connection(&graph_url).await?;

  let node_filter = build_graph_filter("n", &config.id, &scope, source_document_id.as_deref());
  let source_filter = build_graph_filter("source", &config.id, &scope, source_document_id.as_deref());
  let target_filter = build_graph_filter("target", &config.id, &scope, source_document_id.as_deref());
  let node_query = format!(
    "MATCH (n) WHERE {node_filter} RETURN n.id, n.label, n.kind, coalesce(n.description, ''), coalesce(n.sourceFile, '')"
  );
  let edge_query = format!(
    "MATCH (source)-[r]->(target) WHERE {source_filter} AND {target_filter} RETURN source.id, target.id, type(r), coalesce(r.description, ''), coalesce(r.evidence, ''), coalesce(r.sourceFile, '')",
  );

  let node_rows = parse_graph_rows(run_graph_query(&mut connection, &graph_name, &node_query, true).await?)?;
  let edge_rows = parse_graph_rows(run_graph_query(&mut connection, &graph_name, &edge_query, true).await?)?;

  let nodes = node_rows
    .iter()
    .filter_map(|row| {
      Some(KnowledgeGraphNode {
        id: row_string(row, 0)?,
        label: row_string(row, 1)?,
        kind: row_string(row, 2)?,
        kb_id: config.id.clone(),
        scope: scope.clone(),
        description: empty_string_as_none(row_string(row, 3)),
        source_file: empty_string_as_none(row_string(row, 4)),
      })
    })
    .collect::<Vec<_>>();

  let links = edge_rows
    .iter()
    .filter_map(|row| {
      let source = row_string(row, 0)?;
      let target = row_string(row, 1)?;
      let label = row_string(row, 2)?;
      Some(KnowledgeGraphLink {
        id: format!("{source}->{label}->{target}"),
        source,
        target,
        label,
        kb_id: config.id.clone(),
        scope: scope.clone(),
        description: empty_string_as_none(row_string(row, 3)),
        evidence: empty_string_as_none(row_string(row, 4)),
        source_file: empty_string_as_none(row_string(row, 5)),
      })
    })
    .collect::<Vec<_>>();

  Ok(KnowledgeGraphData {
    graph_name,
    knowledge_base_id: config.id,
    knowledge_base_name: config.name,
    scope,
    source_document_id,
    source_file: None,
    nodes,
    links,
  })
}

async fn open_graph_connection(graph_url: &str) -> Result<MultiplexedConnection, String> {
  let client = RedisClient::open(normalize_redis_url(graph_url))
    .map_err(|error| format!("Invalid FalkorDB URL: {error}"))?;
  client
    .get_multiplexed_async_connection()
    .await
    .map_err(|error| format!("Failed to connect to FalkorDB: {error}"))
}

async fn run_graph_query(
  connection: &mut MultiplexedConnection,
  graph_name: &str,
  query: &str,
  readonly: bool,
) -> Result<RedisValue, String> {
  let command_name = if readonly { "GRAPH.RO_QUERY" } else { "GRAPH.QUERY" };
  redis::cmd(command_name)
    .arg(graph_name)
    .arg(query)
    .arg("--compact")
    .query_async(connection)
    .await
    .map_err(|error| format!("FalkorDB query failed: {error}"))
}

async fn remove_existing_document_graph(
  connection: &mut MultiplexedConnection,
  graph_name: &str,
  document: &KnowledgeGraphDocumentInput,
) -> Result<(), String> {
  let delete_relationships_query = format!(
    "MATCH ()-[r]->() WHERE r.documentId = '{source_document_id}' DELETE r",
    source_document_id = escape_cypher_string(&document.source_document_id),
  );
  run_graph_query(connection, graph_name, &delete_relationships_query, false).await?;

  let delete_document_query = format!(
    "MATCH (doc:Document {{id: '{document_id}'}}) DETACH DELETE doc",
    document_id = escape_cypher_string(&document.document_id),
  );
  run_graph_query(connection, graph_name, &delete_document_query, false).await?;

  Ok(())
}

async fn cleanup_orphaned_nodes(
  connection: &mut MultiplexedConnection,
  graph_name: &str,
  knowledge_base_id: &str,
  scope: &str,
) -> Result<(), String> {
  let cleanup_query = format!(
    "MATCH (n:KnowledgeNode) WHERE n.knowledgeBaseId = '{knowledge_base_id}' AND n.scope = '{scope}' AND NOT (n)--() DELETE n",
    knowledge_base_id = escape_cypher_string(knowledge_base_id),
    scope = escape_cypher_string(scope),
  );
  run_graph_query(connection, graph_name, &cleanup_query, false).await?;
  Ok(())
}

fn build_graph_filter(alias: &str, knowledge_base_id: &str, scope: &str, source_document_id: Option<&str>) -> String {
  let mut filters = vec![
    format!("{alias}.knowledgeBaseId = '{}'", escape_cypher_string(knowledge_base_id)),
    format!("{alias}.scope = '{}'", escape_cypher_string(scope)),
  ];

  if let Some(source_document_id) = source_document_id {
    filters.push(format!(
      "{alias}.sourceDocumentId = '{}'",
      escape_cypher_string(source_document_id)
    ));
  }

  filters.join(" AND ")
}

fn parse_graph_rows(value: RedisValue) -> Result<Vec<Vec<RedisValue>>, String> {
  let RedisValue::Array(values) = value else {
    return Err("Unexpected FalkorDB response payload.".to_string());
  };

  if values.len() >= 2 {
    if let RedisValue::Array(rows) = &values[1] {
      let parsed_rows = rows
        .iter()
        .filter_map(|row| match row {
          RedisValue::Array(columns) => Some(columns.clone()),
          _ => None,
        })
        .collect::<Vec<_>>();
      if !parsed_rows.is_empty() {
        return Ok(parsed_rows);
      }
    }
  }

  Ok(values
    .into_iter()
    .skip(1)
    .filter_map(|row| match row {
      RedisValue::Array(columns) => Some(columns),
      _ => None,
    })
    .collect())
}

fn row_string(row: &[RedisValue], index: usize) -> Option<String> {
  redis_value_to_string(row.get(index)?)
}

fn redis_value_to_string(value: &RedisValue) -> Option<String> {
  match value {
    RedisValue::Array(values) => {
      if values.len() >= 2 {
        return redis_value_to_string(&values[1]);
      }

      if values.len() == 1 {
        return redis_value_to_string(&values[0]);
      }

      None
    }
    RedisValue::BulkString(bytes) => String::from_utf8(bytes.clone()).ok(),
    RedisValue::SimpleString(text) => Some(text.clone()),
    RedisValue::VerbatimString { text, .. } => Some(text.clone()),
    RedisValue::Int(number) => Some(number.to_string()),
    RedisValue::Double(number) => Some(number.to_string()),
    RedisValue::Boolean(boolean) => Some(boolean.to_string()),
    RedisValue::BigNumber(number) => Some(number.to_string()),
    RedisValue::Okay => Some("OK".to_string()),
    _ => None,
  }
}

fn empty_string_as_none(value: Option<String>) -> Option<String> {
  value.and_then(|candidate| {
    let trimmed = candidate.trim();
    if trimmed.is_empty() {
      None
    } else {
      Some(trimmed.to_string())
    }
  })
}

fn sanitize_relationship_label(value: &str) -> String {
  let sanitized = value
    .chars()
    .map(|character| {
      if character.is_ascii_alphanumeric() {
        character.to_ascii_uppercase()
      } else {
        '_'
      }
    })
    .collect::<String>()
    .trim_matches('_')
    .to_string();

  if sanitized.is_empty() {
    "RELATES_TO".to_string()
  } else {
    sanitized
  }
}

fn sanitize_identifier(value: &str) -> String {
  value
    .chars()
    .map(|character| if character.is_ascii_alphanumeric() { character.to_ascii_lowercase() } else { '-' })
    .collect::<String>()
    .trim_matches('-')
    .to_string()
}

fn escape_cypher_string(value: &str) -> String {
  value.replace('\\', "\\\\").replace('\'', "\\'")
}

fn truncate_graph_text(value: &str, max_chars: usize) -> String {
  let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
  if normalized.chars().count() <= max_chars {
    return normalized;
  }

  let keep_chars = max_chars.saturating_sub(3);
  format!("{}...", normalized.chars().take(keep_chars).collect::<String>().trim())
}

fn require_non_empty(value: Option<String>, message: &str) -> Result<String, String> {
  let trimmed = value.unwrap_or_default().trim().to_string();
  if trimmed.is_empty() {
    return Err(message.to_string());
  }

  Ok(trimmed)
}

fn normalize_redis_url(url: &str) -> String {
  let trimmed = url.trim();
  if trimmed.starts_with("redis://") || trimmed.starts_with("rediss://") {
    trimmed.to_string()
  } else {
    format!("redis://{trimmed}")
  }
}
