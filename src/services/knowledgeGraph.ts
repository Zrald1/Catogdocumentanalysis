import { invoke, isTauri } from '@tauri-apps/api/core';
import {
  AgentConfig,
  AppConfig,
  KnowledgeBase,
  KnowledgeGraphConnectionTestResult,
  KnowledgeGraphData,
  KnowledgeGraphDocumentLink,
  KnowledgeGraphDocumentNode,
  KnowledgeGraphDocumentPayload,
  KnowledgeGraphIngestionResult,
  KnowledgeGraphIndex,
  KnowledgeGraphScope,
} from '../types';

import { getOrderedAgents } from '../lib/agentConfig';
import { buildLocalAnalysisGraphSnapshot } from '../lib/analysisGraph';
import { DEFAULT_LOCAL_AGENT_MODEL, generateAgentContent, parseJsonResponseText, resolveAgentProviderType } from './agentProviders';

type GraphExtractionResponse = {
  nodes?: Array<{ label?: string; kind?: string; description?: string }>;
  links?: Array<{ source?: string; target?: string; label?: string; description?: string; evidence?: string }>;
};

type PreparedGraphDocument = {
  fileName: string;
  content: string;
};

const GRAPH_EXTRACTION_MODEL = DEFAULT_LOCAL_AGENT_MODEL;
const GRAPH_CHUNK_SIZE = 6000;
const GRAPH_MAX_CHUNKS = 5;
const GRAPH_ANALYSIS_MAX_CHARS = 12000;
const GRAPH_MAX_NODE_LABEL_CHARS = 96;
const GRAPH_MAX_NODE_KIND_CHARS = 32;
const GRAPH_MAX_DESCRIPTION_CHARS = 280;
const GRAPH_MAX_EVIDENCE_CHARS = 360;
const GRAPH_MAX_FILE_NAME_CHARS = 160;
const GRAPH_STOP_WORDS = new Set([
  'about', 'after', 'again', 'against', 'agreement', 'because', 'before', 'between', 'clause', 'compliance',
  'contract', 'document', 'during', 'enterprise', 'following', 'including', 'information', 'legal', 'notice',
  'other', 'party', 'policy', 'process', 'requirement', 'section', 'service', 'shall', 'should', 'their',
  'there', 'these', 'those', 'under', 'which', 'with', 'without',
]);

export const isKnowledgeGraphConfigured = (knowledgeBase: KnowledgeBase) => {
  return Boolean(knowledgeBase.graphUrl?.trim() && knowledgeBase.graphName?.trim());
};

const sanitizeIdentifier = (value: string) => {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'node';
};

const boundedText = (value: string | undefined, maxLength: number) => {
  const normalized = (value || '').replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength
    ? `${normalized.slice(0, Math.max(0, maxLength - 3)).trim()}...`
    : normalized;
};

const normalizeRelationshipLabel = (value: string) => {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'RELATES_TO';
};

const chunkText = (content: string) => {
  const normalizedContent = content.trim();
  if (!normalizedContent) {
    return [];
  }

  const chunks: string[] = [];
  for (let index = 0; index < normalizedContent.length && chunks.length < GRAPH_MAX_CHUNKS; index += GRAPH_CHUNK_SIZE) {
    const chunk = normalizedContent.slice(index, index + GRAPH_CHUNK_SIZE).trim();
    if (chunk) {
      chunks.push(chunk);
    }
  }

  return chunks;
};

const resolveGraphModelConfig = async (config: AppConfig, knowledgeBase: KnowledgeBase) => {
  if (knowledgeBase.graphExtractionProvider === 'heuristic') {
    return null;
  }

  if (knowledgeBase.graphExtractionProvider && knowledgeBase.graphExtractionModel) {
    return {
      id: 'graph-extractor',
      kind: 'specialist',
      agentType: 'custom',
      providerType: knowledgeBase.graphExtractionProvider,
      order: 0,
      name: 'Graph Extractor',
      color: '#00ffff',
      role: 'You are a graph extraction specialist.',
      description: 'Internal agent for graph extraction.',
      apiKey: knowledgeBase.graphExtractionApiKey || '',
      providerUrl: knowledgeBase.graphExtractionBaseUrl || '',
      model: knowledgeBase.graphExtractionModel,
    } satisfies AgentConfig;
  }

  const prioritizedAgents = getOrderedAgents(config);

  for (const agentConfig of prioritizedAgents) {
    if (resolveAgentProviderType(agentConfig) === 'openai-compatible') {
      return {
        ...agentConfig,
        model: agentConfig.model || GRAPH_EXTRACTION_MODEL,
      } satisfies AgentConfig;
    }

    if (agentConfig.apiKey) {
      return {
        ...agentConfig,
        model: agentConfig.model || GRAPH_EXTRACTION_MODEL,
      } satisfies AgentConfig;
    }
  }

  return null;
};

const createNodeId = (
  knowledgeBaseId: string,
  scope: KnowledgeGraphScope,
  sourceDocumentId: string,
  kind: string,
  label: string,
) => {
  const scopeSegment = scope === 'analysis' ? sanitizeIdentifier(sourceDocumentId) : 'shared';
  return `node:${knowledgeBaseId}:${scope}:${scopeSegment}:${sanitizeIdentifier(kind)}:${sanitizeIdentifier(label)}`;
};

const normalizeGraphPayload = (
  knowledgeBase: KnowledgeBase,
  scope: KnowledgeGraphScope,
  sourceDocumentId: string,
  fileName: string,
  rawChunks: GraphExtractionResponse[],
): KnowledgeGraphDocumentPayload => {
  const nodes = new Map<string, KnowledgeGraphDocumentNode>();
  const links = new Map<string, KnowledgeGraphDocumentLink>();

  const registerNode = (label: string, kind = 'concept', description?: string) => {
    const normalizedLabel = boundedText(label, GRAPH_MAX_NODE_LABEL_CHARS);
    if (!normalizedLabel) {
      return null;
    }

    const normalizedKind = boundedText(kind, GRAPH_MAX_NODE_KIND_CHARS).toLowerCase() || 'concept';
    const nodeId = createNodeId(knowledgeBase.id, scope, sourceDocumentId, normalizedKind, normalizedLabel);
    const existingNode = nodes.get(nodeId);

    nodes.set(nodeId, {
      id: nodeId,
      label: normalizedLabel,
      kind: normalizedKind,
      description: boundedText(description, GRAPH_MAX_DESCRIPTION_CHARS) || existingNode?.description,
    });

    return nodeId;
  };

  rawChunks.forEach((chunk) => {
    chunk.nodes?.forEach((node) => {
      if (node.label?.trim()) {
        registerNode(node.label, node.kind, node.description);
      }
    });

    chunk.links?.forEach((link) => {
      const sourceLabel = boundedText(link.source, GRAPH_MAX_NODE_LABEL_CHARS);
      const targetLabel = boundedText(link.target, GRAPH_MAX_NODE_LABEL_CHARS);
      if (!sourceLabel || !targetLabel) {
        return;
      }

      const sourceNodeId = registerNode(sourceLabel, 'concept');
      const targetNodeId = registerNode(targetLabel, 'concept');
      if (!sourceNodeId || !targetNodeId) {
        return;
      }

      const label = normalizeRelationshipLabel(link.label || 'RELATES_TO');
      const linkId = `${sourceNodeId}->${label}->${targetNodeId}`;
      const existingLink = links.get(linkId);

      links.set(linkId, {
        source: sourceNodeId,
        target: targetNodeId,
        label,
        description: boundedText(link.description, GRAPH_MAX_DESCRIPTION_CHARS) || existingLink?.description,
        evidence: boundedText(link.evidence, GRAPH_MAX_EVIDENCE_CHARS) || existingLink?.evidence,
      });
    });
  });

  if (nodes.size === 0) {
    throw new Error(`No graph entities were extracted from ${fileName}. Add more document text or verify the active AI provider.`);
  }

  return {
    documentId: `${knowledgeBase.id}:${scope}:${sanitizeIdentifier(fileName)}:${sanitizeIdentifier(sourceDocumentId)}`,
    fileName: boundedText(fileName, GRAPH_MAX_FILE_NAME_CHARS) || fileName,
    scope,
    sourceDocumentId,
    nodes: Array.from(nodes.values()).slice(0, 48),
    links: Array.from(links.values()).slice(0, 96),
  };
};

const extractGraphChunk = async (
  agentConfig: AgentConfig,
  knowledgeBase: KnowledgeBase,
  document: PreparedGraphDocument,
  chunk: string,
  scope: KnowledgeGraphScope,
  contextSummary?: string,
) => {
  const prompt = `
Return JSON only in this shape:
{
  "nodes": [
    { "label": "...", "kind": "concept|entity|requirement|risk|obligation|party", "description": "..." }
  ],
  "links": [
    { "source": "...", "target": "...", "label": "RELATES_TO", "description": "...", "evidence": "..." }
  ]
}

Rules:
- Extract only concrete, text-supported entities and relationships.
- Prefer enterprise/legal/compliance concepts over generic nouns.
- Use short, stable labels.
- Use uppercase snake case for relationship labels.
- Return at most 12 nodes and 16 links.
- Do not include the document file itself as a node.
- Do not guess or infer unsupported facts beyond the supplied document and analysis context.

Knowledge base: ${knowledgeBase.name}
Scope: ${scope}
Document: ${document.fileName}
${contextSummary ? `Analysis context:\n${contextSummary}\n` : ''}
  Document excerpt:
  ${chunk}
    `;

  const { text: responseText } = await generateAgentContent(
    {
      ...agentConfig,
      model: agentConfig.model || GRAPH_EXTRACTION_MODEL,
    },
    prompt,
    'application/json',
  );
  return parseJsonResponseText<GraphExtractionResponse>(responseText);
};

const extractHeuristicGraphChunk = (
  chunk: string,
): GraphExtractionResponse => {
  const normalizedChunk = chunk.replace(/\s+/g, ' ').trim();
  const termCounts = new Map<string, number>();
  const sentenceTerms: string[][] = [];

  const sentences = normalizedChunk
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);

  sentences.forEach((sentence) => {
    const matches = sentence.match(/\b[A-Za-z][A-Za-z0-9-]{3,}(?:\s+[A-Za-z][A-Za-z0-9-]{3,}){0,2}\b/g) || [];
    const terms = matches
      .map((term) => term.trim())
      .filter((term) => {
        const normalizedTerm = term.toLowerCase();
        return normalizedTerm.length > 3 && !GRAPH_STOP_WORDS.has(normalizedTerm);
      });

    sentenceTerms.push(terms);
    terms.forEach((term) => {
      termCounts.set(term, (termCounts.get(term) || 0) + 1);
    });
  });

  const nodes = Array.from(termCounts.entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, 12)
    .map(([label, frequency]) => ({
      label,
      kind: frequency > 1 ? 'concept' : 'entity',
      description: `Locally extracted from repeated text patterns (${frequency} mention${frequency === 1 ? '' : 's'}).`,
    }));

  const nodeLabels = new Set(nodes.map((node) => node.label));
  const links = sentenceTerms.flatMap((terms) => {
    const filteredTerms = terms.filter((term) => nodeLabels.has(term));
    return filteredTerms.slice(1).map((term, index) => ({
      source: filteredTerms[index],
      target: term,
      label: 'CO_OCCURS_WITH',
      description: 'Connected from the same sentence during local graph extraction.',
      evidence: normalizedChunk.slice(0, 240),
    }));
  }).slice(0, 16);

  return { nodes, links };
};

const extractKnowledgeGraphDocument = async (
  config: AppConfig,
  knowledgeBase: KnowledgeBase,
  document: PreparedGraphDocument,
  scope: KnowledgeGraphScope,
  sourceDocumentId: string,
  contextSummary?: string,
) => {
  const graphModelConfig = await resolveGraphModelConfig(config, knowledgeBase);
  const chunks = chunkText(document.content);

  if (chunks.length === 0) {
    throw new Error(`No readable text content was available to build a graph for ${document.fileName}.`);
  }

  const extractedChunks: GraphExtractionResponse[] = [];
  for (const chunk of chunks) {
    try {
      extractedChunks.push(
        graphModelConfig
          ? await extractGraphChunk(
            graphModelConfig,
            knowledgeBase,
            document,
            chunk,
            scope,
            contextSummary,
          )
          : extractHeuristicGraphChunk(chunk),
      );
    } catch (error) {
      console.warn(`AI Graph extraction failed for chunk in ${document.fileName}, falling back to heuristic:`, error);
      extractedChunks.push(extractHeuristicGraphChunk(chunk));
    }
  }

  return normalizeGraphPayload(
    knowledgeBase,
    scope,
    sourceDocumentId,
    document.fileName,
    extractedChunks,
  );
};

const extractAnalysisKnowledgeGraphDocument = (
  knowledgeBase: KnowledgeBase,
  document: PreparedGraphDocument,
  sourceDocumentId: string,
  contextSummary?: string,
) => {
  const boundedContent = boundedText(
    [
      contextSummary,
      document.content,
    ].filter(Boolean).join('\n\n'),
    GRAPH_ANALYSIS_MAX_CHARS,
  );
  const chunks = chunkText(boundedContent);

  if (chunks.length === 0) {
    throw new Error(`No readable text content was available to build a graph for ${document.fileName}.`);
  }

  return normalizeGraphPayload(
    knowledgeBase,
    'analysis',
    sourceDocumentId,
    document.fileName,
    chunks.map(extractHeuristicGraphChunk),
  );
};

export const testKnowledgeGraphConnection = async (
  knowledgeBase: KnowledgeBase,
): Promise<KnowledgeGraphConnectionTestResult> => {
  if (!isTauri()) {
    throw new Error('Knowledge-graph connectivity is available in the Tauri desktop app only.');
  }

  if (!isKnowledgeGraphConfigured(knowledgeBase)) {
    throw new Error('Complete the FalkorDB URL and graph name before testing graph connectivity.');
  }

  return invoke<KnowledgeGraphConnectionTestResult>('test_knowledge_graph_connection', {
    config: knowledgeBase,
  });
};

export const ingestKnowledgeGraphDocument = async (
  knowledgeBase: KnowledgeBase,
  document: KnowledgeGraphDocumentPayload,
) => {
  if (!isTauri()) {
    throw new Error('Knowledge-graph ingestion is available in the Tauri desktop app only.');
  }

  if (!isKnowledgeGraphConfigured(knowledgeBase)) {
    throw new Error('Complete the FalkorDB URL and graph name before indexing a graph.');
  }

  return invoke<KnowledgeGraphIngestionResult>('ingest_knowledge_graph_document', {
    config: knowledgeBase,
    document,
  });
};

export const queryKnowledgeGraph = async (
  knowledgeBase: KnowledgeBase,
  scope: KnowledgeGraphScope,
  sourceDocumentId?: string,
) => {
  if (!isTauri() || !isKnowledgeGraphConfigured(knowledgeBase)) {
    return {
      graphName: knowledgeBase.graphName || '',
      knowledgeBaseId: knowledgeBase.id,
      knowledgeBaseName: knowledgeBase.name,
      scope,
      sourceDocumentId,
      nodes: [],
      links: [],
    } satisfies KnowledgeGraphData;
  }

  return invoke<KnowledgeGraphData>('query_knowledge_graph', {
    config: knowledgeBase,
    scope,
    sourceDocumentId,
  });
};

export const indexKnowledgeBaseGraphDocuments = async (
  config: AppConfig,
  knowledgeBase: KnowledgeBase,
  documents: PreparedGraphDocument[],
) => {
  let totalNodes = 0;
  let totalEdges = 0;

  for (const document of documents) {
    const payload = await extractKnowledgeGraphDocument(
      config,
      knowledgeBase,
      document,
      'knowledge-base',
      document.fileName,
    );
    const result = await ingestKnowledgeGraphDocument(knowledgeBase, payload);
    totalNodes += result.nodeCount;
    totalEdges += result.edgeCount;
  }

  return {
    graphName: knowledgeBase.graphName || '',
    nodeCount: totalNodes,
    edgeCount: totalEdges,
  };
};

const resolveAnalysisGraphKnowledgeBase = (
  config: AppConfig,
  preferredKnowledgeBaseIds: string[],
) => {
  const preferredKnowledgeBases = config.knowledgeBases.filter((knowledgeBase) =>
    preferredKnowledgeBaseIds.includes(knowledgeBase.id),
  );

  return preferredKnowledgeBases.find(isKnowledgeGraphConfigured)
    || config.knowledgeBases.find((knowledgeBase) => isKnowledgeGraphConfigured(knowledgeBase));
};

const resolveAnalysisGraphFallbackKnowledgeBase = (
  config: AppConfig,
  preferredKnowledgeBaseIds: string[],
): KnowledgeBase => {
  const preferredKnowledgeBase = config.knowledgeBases.find((knowledgeBase) =>
    preferredKnowledgeBaseIds.includes(knowledgeBase.id),
  );

  return preferredKnowledgeBase
    || config.knowledgeBases[0]
    || {
      id: 'local-analysis',
      name: 'Local Analysis Graph',
      embedderProvider: 'openai-compatible',
      ragEngine: 'standard',
      embeddingModel: 'local-analysis',
      chunkSize: GRAPH_CHUNK_SIZE,
      overlap: 0,
    };
};

const buildFallbackGraphFromPayload = (
  knowledgeBase: KnowledgeBase,
  fileName: string,
  sourceDocumentId: string,
  payload: KnowledgeGraphDocumentPayload,
): KnowledgeGraphData => ({
  graphName: knowledgeBase.graphName || '',
  knowledgeBaseId: knowledgeBase.id,
  knowledgeBaseName: knowledgeBase.name,
  scope: payload.scope,
  sourceDocumentId,
  sourceFile: fileName,
  nodes: [
    {
      id: payload.documentId,
      label: fileName,
      kind: 'document',
      kbId: knowledgeBase.id,
      scope: payload.scope,
      sourceFile: fileName,
      description: `Indexed ${payload.scope} document`,
    },
    ...payload.nodes.map((node) => ({
      id: node.id,
      label: node.label,
      kind: node.kind,
      kbId: knowledgeBase.id,
      scope: payload.scope,
      sourceFile: fileName,
      description: node.description,
    })),
  ],
  links: [
    ...payload.nodes.map((node) => ({
      id: `${payload.documentId}->MENTIONS->${node.id}`,
      source: payload.documentId,
      target: node.id,
      label: 'MENTIONS',
      kbId: knowledgeBase.id,
      scope: payload.scope,
      sourceFile: fileName,
      description: `Document mentions ${node.label}.`,
    })),
    ...payload.links.map((link) => ({
      id: `${link.source}->${link.label}->${link.target}`,
      source: link.source,
      target: link.target,
      label: link.label,
      kbId: knowledgeBase.id,
      scope: payload.scope,
      sourceFile: fileName,
      description: link.description,
      evidence: link.evidence,
    })),
  ],
});

const buildLocalGraphIndex = (
  knowledgeBase: KnowledgeBase,
  fileName: string,
  sourceDocumentId: string,
  graph: KnowledgeGraphData,
): KnowledgeGraphIndex => ({
  graphName: knowledgeBase.graphName || 'LOCAL_ANALYSIS_GRAPH',
  storageMode: 'local',
  knowledgeBaseId: knowledgeBase.id,
  knowledgeBaseName: knowledgeBase.name,
  scope: 'analysis',
  sourceDocumentId,
  sourceFile: fileName,
  nodeCount: graph.nodes.length,
  edgeCount: graph.links.length,
});

export const indexAnalysisKnowledgeGraph = async (
  config: AppConfig,
  fileName: string,
  content: string,
  sourceDocumentId: string,
  contextSummary: string,
  preferredKnowledgeBaseIds: string[],
) : Promise<{
  graph?: KnowledgeGraphData;
  graphIndex?: KnowledgeGraphIndex;
  storageMode: 'indexed' | 'local' | 'skipped';
  message: string;
}> => {
  const knowledgeBase = resolveAnalysisGraphKnowledgeBase(config, preferredKnowledgeBaseIds);
  const fallbackKnowledgeBase = knowledgeBase || resolveAnalysisGraphFallbackKnowledgeBase(config, preferredKnowledgeBaseIds);

  const localSnapshot = buildLocalAnalysisGraphSnapshot(
    {
      id: sourceDocumentId,
      fileName,
      status: 'complete',
      findings: [],
      corrections: [],
      obligations: [],
      createdAt: new Date().toISOString(),
    },
    fallbackKnowledgeBase.id,
    fallbackKnowledgeBase.name,
    `${fileName}\n${contextSummary}\n${content}`,
  );

  let payload: KnowledgeGraphDocumentPayload;
  let fallbackGraph: KnowledgeGraphData;

  try {
    payload = extractAnalysisKnowledgeGraphDocument(
      fallbackKnowledgeBase,
      { fileName, content },
      sourceDocumentId,
      contextSummary,
    );
    fallbackGraph = buildFallbackGraphFromPayload(fallbackKnowledgeBase, fileName, sourceDocumentId, payload);
  } catch (error) {
    return {
      graph: localSnapshot.graph,
      graphIndex: {
        ...localSnapshot.graphIndex,
        graphName: fallbackKnowledgeBase.graphName || localSnapshot.graphIndex.graphName,
      },
      storageMode: 'local',
      message: `Prepared a local analysis graph because automated graph extraction failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!knowledgeBase) {
    return {
      graph: fallbackGraph,
      graphIndex: buildLocalGraphIndex(fallbackKnowledgeBase, fileName, sourceDocumentId, fallbackGraph),
      storageMode: 'local',
      message: 'Prepared a local analysis graph because no FalkorDB-enabled knowledge base is configured.',
    };
  }

  try {
    const ingestionResult = await ingestKnowledgeGraphDocument(knowledgeBase, payload);

    return {
      graph: fallbackGraph,
      graphIndex: {
        graphName: ingestionResult.graphName,
        storageMode: 'indexed',
        knowledgeBaseId: knowledgeBase.id,
        knowledgeBaseName: knowledgeBase.name,
        scope: 'analysis' as const,
        sourceDocumentId,
        sourceFile: fileName,
        nodeCount: ingestionResult.nodeCount,
        edgeCount: ingestionResult.edgeCount,
      },
      storageMode: 'indexed',
      message: `Stored the analysis graph in ${ingestionResult.graphName}.`,
    };
  } catch (error) {
    return {
      graph: fallbackGraph,
      graphIndex: buildLocalGraphIndex(fallbackKnowledgeBase, fileName, sourceDocumentId, fallbackGraph),
      storageMode: 'local',
      message: `Prepared a local analysis graph because FalkorDB indexing was unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};
