export interface Message {
  id: string;
  agent: string;
  text: string;
  citations?: MessageCitation[];
  timestamp: Date;
  isComplete?: boolean;
  lobstertrap?: LobsterTrapReport;
}

export interface MessageCitation {
  label: string;
  excerpt: string;
}

export type ChatAgent = string;
export type AgentKind = 'core' | 'specialist';
export type AgentType = 'custom' | 'auditor' | 'legal';
export type AgentProviderType = 'openai-compatible' | 'gemini';
export type ExecutionMode = 'sequential' | 'parallel';
export type EmbeddingProvider = 'openai-compatible';
export type KnowledgeGraphScope = 'knowledge-base' | 'analysis';
export type VisionProvider = 'openai-compatible' | 'gemini';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  agent: ChatAgent;
  text: string;
  timestamp: Date;
}

export interface AgentExecutionMessage {
  id: string;
  documentId: string;
  fileName: string;
  agent: ChatAgent | 'system';
  stage: 'queued' | 'retrieval' | 'review' | 'synthesis' | 'graph' | 'complete';
  status: 'running' | 'complete' | 'fallback' | 'error';
  text: string;
  timestamp: Date;
  lobstertrap?: LobsterTrapReport;
}

export interface LobsterTrapRequestHeaders {
  declared_intent?: string;
  declared_paths?: string[];
  declared_commands?: string[];
  declared_domains?: string[];
  agent_id?: string;
  compliance_mode?: 'strict' | 'relaxed' | 'strict-legal';
}

export interface LobsterTrapReport {
  request_id: string;
  verdict: 'ALLOW' | 'DENY' | 'LOG' | 'HUMAN_REVIEW' | 'MODIFY' | 'QUARANTINE';
  ingress: {
    declared?: LobsterTrapRequestHeaders;
    detected?: {
      intent_category: string;
      intent_confidence: number;
      risk_score: number;
      contains_hallucination?: boolean;
      threats?: string[];
      [key: string]: any;
    };
    mismatches: Array<{
      field: string;
      declared: any;
      detected: any;
      severity: 'warning' | 'critical';
    }>;
    action: string;
  };
  egress: {
    detected?: {
      risk_score: number;
      contains_hallucination?: boolean;
      threats?: string[];
      [key: string]: any;
    };
    action: string;
  };
}

export interface KnowledgeBase {
  id: string;
  name: string;
  url?: string;
  apiKey?: string;
  collectionName?: string;
  graphUrl?: string;
  graphName?: string;
  embedderProvider: EmbeddingProvider;
  ragEngine: string;
  embeddingModel: string;
  embeddingApiKey?: string;
  embeddingBaseUrl?: string;
  embeddingModelDimension?: number;
  searchMinScore?: number;
  searchMaxResults?: number;
  chunkSize: number;
  overlap: number;
  graphExtractionProvider?: AgentProviderType | 'heuristic';
  graphExtractionModel?: string;
  graphExtractionApiKey?: string;
  graphExtractionBaseUrl?: string;
}

export interface AgentConfig {
  id: ChatAgent;
  kind: AgentKind;
  agentType: AgentType;
  providerType: AgentProviderType;
  order: number;
  name: string;
  color: string;
  role: string;
  description: string;
  apiKey: string;
  providerUrl: string;
  model: string;
  kbIds?: string[];
}



export interface VisionConfig {
  provider: VisionProvider;
  model: string;
  baseUrl: string;
  apiKey: string;
  detectorModel: string;
  ocrModel: string;
}

export interface AppConfig {
  agents: Record<string, AgentConfig>;
  knowledgeBases: KnowledgeBase[];
  selectedKBIds: string[];
  vision: VisionConfig;
}

export interface VisionPreparedCapture {
  sourceFileName: string;
  name: string;
  content: string;
  summary: string;
  citations: MessageCitation[];
}

export interface DocumentAnalysis {
  id: string;
  fileName: string;
  status: 'pending' | 'analyzing' | 'complete' | 'error';
  findings: Finding[];
  corrections: Correction[];
  obligations: Obligation[];
  graph?: KnowledgeGraphData;
  graphIndex?: KnowledgeGraphIndex;
  lobstertrap?: LobsterTrapReport;
  createdAt?: string;
}

export interface Finding {
  type: 'missing' | 'incorrect' | 'info';
  severity: 'low' | 'medium' | 'high';
  message: string;
}

export interface Correction {
  original: string;
  suggested: string;
  reason: string;
  isRequirement: boolean; // green if requirement to add, red if to remove/fix
}

export interface Obligation {
  title: string;
  owner: string;
  dueDate: string;
  priority: 'low' | 'medium' | 'high';
  status: 'open' | 'in_progress' | 'blocked' | 'resolved';
  rationale: string;
  sourceExcerpt: string;
}

export interface KnowledgeBaseSettings {
  ragEngine: 'standard' | 'enhanced' | 'neural' | 'hybrid';
  embeddingModel: string;
  chunkSize: number;
  overlap: number;
}

export interface KnowledgeBaseSearchResult {
  id: string;
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  score: number;
  content: string;
  source?: string;
}

export interface KnowledgeBaseConnectionTestResult {
  provider: string;
  model: string;
  collectionName: string;
  vectorMatches: number;
  message: string;
}

export interface KnowledgeBaseIngestionResult {
  ingestedFiles: number;
  chunkCount: number;
  graphNodesIndexed?: number;
  graphEdgesIndexed?: number;
  message: string;
}

export interface KnowledgeBaseIngestionProgress {
  stage: 'reading' | 'embedding' | 'indexing' | 'complete';
  progress: number;
  processedFiles: number;
  totalFiles: number;
  message: string;
}

export interface KnowledgeBaseIndexedDocument {
  fileName: string;
  chunkCount: number;
}

export interface KnowledgeBaseDeleteDocumentsResult {
  deletedFiles: string[];
  deletedPoints: number;
  message: string;
}

export interface KnowledgeGraphNode {
  id: string;
  label: string;
  kind: string;
  kbId: string;
  scope: KnowledgeGraphScope;
  sourceFile?: string;
  description?: string;
}

export interface KnowledgeGraphLink {
  id: string;
  source: string;
  target: string;
  label: string;
  kbId: string;
  scope: KnowledgeGraphScope;
  sourceFile?: string;
  description?: string;
  evidence?: string;
}

export interface KnowledgeGraphData {
  graphName: string;
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  scope: KnowledgeGraphScope;
  sourceDocumentId?: string;
  sourceFile?: string;
  nodes: KnowledgeGraphNode[];
  links: KnowledgeGraphLink[];
}

export interface KnowledgeGraphIndex {
  graphName: string;
  storageMode: 'indexed' | 'local';
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  scope: KnowledgeGraphScope;
  sourceDocumentId: string;
  sourceFile: string;
  nodeCount: number;
  edgeCount: number;
}

export interface KnowledgeGraphConnectionTestResult {
  graphName: string;
  message: string;
}

export interface KnowledgeGraphDocumentNode {
  id: string;
  label: string;
  kind: string;
  description?: string;
}

export interface KnowledgeGraphDocumentLink {
  source: string;
  target: string;
  label: string;
  description?: string;
  evidence?: string;
}

export interface KnowledgeGraphDocumentPayload {
  documentId: string;
  fileName: string;
  scope: KnowledgeGraphScope;
  sourceDocumentId: string;
  nodes: KnowledgeGraphDocumentNode[];
  links: KnowledgeGraphDocumentLink[];
}

export interface KnowledgeGraphIngestionResult {
  graphName: string;
  sourceDocumentId: string;
  nodeCount: number;
  edgeCount: number;
  message: string;
}
