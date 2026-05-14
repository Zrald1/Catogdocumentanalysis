import { EmbeddingProvider } from '../types';

type EmbeddingModelProfile = {
  dimension: number;
  scoreThreshold: number;
};

const EMBEDDING_MODEL_PROFILES: Record<EmbeddingProvider, Record<string, EmbeddingModelProfile>> = {
  'openai-compatible': {
    'nomic-embed-text-v1.5': { dimension: 768, scoreThreshold: 0.2 },
    'text-embedding-3-small': { dimension: 1536, scoreThreshold: 0.4 },
    'text-embedding-3-large': { dimension: 3072, scoreThreshold: 0.4 },
    'text-embedding-ada-002': { dimension: 1536, scoreThreshold: 0.4 },
    'nomic-embed-code': { dimension: 3584, scoreThreshold: 0.15 },
  },
};

export const getDefaultEmbeddingModel = (provider: EmbeddingProvider) => {
  return 'nomic-embed-text-v1.5';
};

export const resolveEmbeddingModel = (provider: EmbeddingProvider, modelId?: string) => {
  return modelId?.trim() || getDefaultEmbeddingModel(provider);
};

export const getEmbeddingModelDimension = (provider: EmbeddingProvider, modelId?: string) => {
  const resolvedModelId = resolveEmbeddingModel(provider, modelId);
  return EMBEDDING_MODEL_PROFILES[provider][resolvedModelId]?.dimension || 768;
};

export const getEmbeddingScoreThreshold = (provider: EmbeddingProvider, modelId?: string) => {
  const resolvedModelId = resolveEmbeddingModel(provider, modelId);
  return EMBEDDING_MODEL_PROFILES[provider][resolvedModelId]?.scoreThreshold ?? 0.2;
};

export const getEmbeddingModelOptions = (provider: EmbeddingProvider) => {
  return Object.keys(EMBEDDING_MODEL_PROFILES[provider]).map((modelId) => ({
    label: modelId,
    value: modelId,
    dimension: EMBEDDING_MODEL_PROFILES[provider][modelId].dimension,
    scoreThreshold: EMBEDDING_MODEL_PROFILES[provider][modelId].scoreThreshold,
  }));
};
