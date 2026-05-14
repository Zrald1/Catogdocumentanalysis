import { invoke, isTauri } from '@tauri-apps/api/core';
import { getEmbeddingModelDimension, getEmbeddingScoreThreshold, resolveEmbeddingModel } from '../lib/embeddingModels';
import { getGeminiApiKey } from '../lib/runtime';
import { readFileForAnalysis } from '../lib/fileContent';
import { indexKnowledgeBaseGraphDocuments, isKnowledgeGraphConfigured, testKnowledgeGraphConnection } from './knowledgeGraph';
import {
  AppConfig,
  KnowledgeBase,
  KnowledgeBaseConnectionTestResult,
  KnowledgeBaseDeleteDocumentsResult,
  KnowledgeBaseIndexedDocument,
  KnowledgeBaseIngestionResult,
  KnowledgeBaseIngestionProgress,
  KnowledgeBaseSearchResult,
} from '../types';

type KnowledgeBaseQuerySummary = {
  results: KnowledgeBaseSearchResult[];
  errors: { knowledgeBaseName: string; message: string }[];
  queriedKnowledgeBaseCount: number;
};

const DEFAULT_SEARCH_MAX_RESULTS = 5;

const resolveEmbeddingApiKey = (knowledgeBase: KnowledgeBase) => {
  return knowledgeBase.embeddingApiKey?.trim() || '';
};

export const isKnowledgeBaseConfigured = (knowledgeBase: KnowledgeBase) => {
  const hasVectorStoreConfig = Boolean(
    knowledgeBase.url?.trim()
      && knowledgeBase.collectionName?.trim(),
  );

  if (!hasVectorStoreConfig) {
    return false;
  }

  if (knowledgeBase.embedderProvider === 'openai-compatible') {
    return Boolean(knowledgeBase.embeddingBaseUrl?.trim());
  }

  return Boolean(resolveEmbeddingApiKey(knowledgeBase));
};

const getRuntimeKnowledgeBaseConfig = (knowledgeBase: KnowledgeBase): KnowledgeBase => {
  const embeddingModel = resolveEmbeddingModel(knowledgeBase.embedderProvider, knowledgeBase.embeddingModel);
  const embeddingModelDimension =
    knowledgeBase.embeddingModelDimension
    ?? getEmbeddingModelDimension(knowledgeBase.embedderProvider, embeddingModel);

  return {
    ...knowledgeBase,
    embeddingModel,
    embeddingApiKey: resolveEmbeddingApiKey(knowledgeBase),
    embeddingModelDimension,
    searchMinScore:
      knowledgeBase.searchMinScore
      ?? getEmbeddingScoreThreshold(knowledgeBase.embedderProvider, embeddingModel),
    searchMaxResults: knowledgeBase.searchMaxResults ?? DEFAULT_SEARCH_MAX_RESULTS,
  };
};

export const queryKnowledgeBase = async (
  knowledgeBase: KnowledgeBase,
  query: string,
  limit?: number,
): Promise<KnowledgeBaseSearchResult[]> => {
  if (!isTauri() || !isKnowledgeBaseConfigured(knowledgeBase) || !query.trim()) {
    return [];
  }

  return invoke<KnowledgeBaseSearchResult[]>('query_knowledge_base', {
    config: getRuntimeKnowledgeBaseConfig(knowledgeBase),
    query,
    limit: limit ?? knowledgeBase.searchMaxResults ?? DEFAULT_SEARCH_MAX_RESULTS,
  });
};

export const testKnowledgeBaseConnection = async (
  knowledgeBase: KnowledgeBase,
): Promise<KnowledgeBaseConnectionTestResult> => {
  if (!isTauri()) {
    throw new Error('Knowledge base connection tests are available in the Tauri desktop app only.');
  }

  if (!isKnowledgeBaseConfigured(knowledgeBase)) {
    throw new Error('Complete the Qdrant and embedding settings before running a connection test.');
  }

  const vectorResult = await invoke<KnowledgeBaseConnectionTestResult>('test_knowledge_base_connection', {
    config: getRuntimeKnowledgeBaseConfig(knowledgeBase),
  });

  const graphResult = await testKnowledgeGraphConnection(knowledgeBase);

  return {
    ...vectorResult,
    message: `${vectorResult.message} ${graphResult.message}`,
  };
};

export const ingestKnowledgeBaseFiles = async (
  config: AppConfig,
  knowledgeBase: KnowledgeBase,
  files: File[],
  onProgress?: (progress: KnowledgeBaseIngestionProgress) => void,
): Promise<KnowledgeBaseIngestionResult> => {
  if (!isTauri()) {
    throw new Error('Knowledge base ingestion is available in the Tauri desktop app only.');
  }

  if (!isKnowledgeBaseConfigured(knowledgeBase)) {
    throw new Error('Complete the knowledge base connection settings before uploading files.');
  }

  if (!isKnowledgeGraphConfigured(knowledgeBase)) {
    throw new Error('Complete the FalkorDB URL and graph name before uploading files into this knowledge base.');
  }

  onProgress?.({
    stage: 'reading',
    progress: 5,
    processedFiles: 0,
    totalFiles: files.length,
    message: `Preparing ${files.length} file(s) for embedding...`,
  });

  const documents: Array<{ fileName: string; content: string }> = [];
  for (const [index, file] of files.entries()) {
    documents.push({
      fileName: file.name,
      content: await readFileForAnalysis(file),
    });
    onProgress?.({
      stage: 'reading',
      progress: Math.max(10, Math.round(((index + 1) / Math.max(files.length, 1)) * 40)),
      processedFiles: index + 1,
      totalFiles: files.length,
      message: `Read ${index + 1} of ${files.length} file(s). Ready to embed into ${knowledgeBase.name}.`,
    });
  }

  onProgress?.({
    stage: 'embedding',
    progress: 65,
    processedFiles: files.length,
    totalFiles: files.length,
    message: `Embedding ${files.length} file(s) into ${knowledgeBase.name}...`,
  });

  const vectorResult = await invoke<KnowledgeBaseIngestionResult>('ingest_knowledge_base_files', {
    config: getRuntimeKnowledgeBaseConfig(knowledgeBase),
    documents,
  });

  onProgress?.({
    stage: 'indexing',
    progress: 85,
    processedFiles: files.length,
    totalFiles: files.length,
    message: `Embedding complete. Building graph index for ${files.length} file(s)...`,
  });

  const graphResult = await indexKnowledgeBaseGraphDocuments(config, knowledgeBase, documents);

  onProgress?.({
    stage: 'complete',
    progress: 100,
    processedFiles: files.length,
    totalFiles: files.length,
    message: `${files.length} file(s) embedded and graph-indexed successfully.`,
  });

  return {
    ...vectorResult,
    graphNodesIndexed: graphResult.nodeCount,
    graphEdgesIndexed: graphResult.edgeCount,
    message: `${vectorResult.message} Graph indexed ${graphResult.nodeCount} node(s) and ${graphResult.edgeCount} edge(s) in ${graphResult.graphName}.`,
  };
};

export const queryKnowledgeBases = async (
  knowledgeBases: KnowledgeBase[],
  query: string,
  limit?: number,
): Promise<KnowledgeBaseQuerySummary> => {
  const configuredKnowledgeBases = knowledgeBases.filter(isKnowledgeBaseConfigured);
  if (configuredKnowledgeBases.length === 0 || !query.trim()) {
    return {
      results: [],
      errors: [],
      queriedKnowledgeBaseCount: 0,
    };
  }

  const settledResults = await Promise.allSettled(
    configuredKnowledgeBases.map(async (knowledgeBase) => ({
      knowledgeBaseName: knowledgeBase.name,
      results: await queryKnowledgeBase(knowledgeBase, query, limit),
    })),
  );

  const results: KnowledgeBaseSearchResult[] = [];
  const errors: { knowledgeBaseName: string; message: string }[] = [];

  settledResults.forEach((settledResult, index) => {
    const knowledgeBaseName = configuredKnowledgeBases[index].name;

    if (settledResult.status === 'fulfilled') {
      results.push(...settledResult.value.results);
      return;
    }

    errors.push({
      knowledgeBaseName,
      message: settledResult.reason instanceof Error
        ? settledResult.reason.message
        : String(settledResult.reason),
    });
  });

  return {
    results: results.sort((left, right) => right.score - left.score),
    errors,
    queriedKnowledgeBaseCount: configuredKnowledgeBases.length,
  };
};

export const listKnowledgeBaseDocuments = async (
  knowledgeBase: KnowledgeBase,
): Promise<KnowledgeBaseIndexedDocument[]> => {
  if (!isTauri()) {
    throw new Error('Embedded-file management is available in the Tauri desktop app only.');
  }

  if (!isKnowledgeBaseConfigured(knowledgeBase)) {
    throw new Error('Complete the knowledge base connection settings before listing embedded files.');
  }

  return invoke<KnowledgeBaseIndexedDocument[]>('list_knowledge_base_documents', {
    config: getRuntimeKnowledgeBaseConfig(knowledgeBase),
  });
};

export const deleteKnowledgeBaseDocuments = async (
  knowledgeBase: KnowledgeBase,
  fileNames: string[],
): Promise<KnowledgeBaseDeleteDocumentsResult> => {
  if (!isTauri()) {
    throw new Error('Embedded-file management is available in the Tauri desktop app only.');
  }

  if (!isKnowledgeBaseConfigured(knowledgeBase)) {
    throw new Error('Complete the knowledge base connection settings before deleting embedded files.');
  }

  return invoke<KnowledgeBaseDeleteDocumentsResult>('delete_knowledge_base_documents', {
    config: getRuntimeKnowledgeBaseConfig(knowledgeBase),
    fileNames,
  });
};

export const formatKnowledgeBaseContext = (results: KnowledgeBaseSearchResult[]) => {
  return results
    .slice(0, 6)
    .map((result, index) => {
      const source = result.source ? ` | Source: ${result.source}` : '';
      return `[Context ${index + 1}] KB: ${result.knowledgeBaseName}${source}\n${result.content}`;
    })
    .join('\n\n');
};

export const formatKnowledgeBaseSources = (results: KnowledgeBaseSearchResult[]) => {
  const uniqueSources = new Set<string>();

  results.slice(0, 5).forEach((result) => {
    uniqueSources.add(
      result.source
        ? `${result.knowledgeBaseName} - ${result.source}`
        : `${result.knowledgeBaseName} - score ${result.score.toFixed(2)}`,
    );
  });

  if (uniqueSources.size === 0) {
    return '';
  }

  return `\n\n**Knowledge base sources**\n${Array.from(uniqueSources).map((source) => `- ${source}`).join('\n')}`;
};
