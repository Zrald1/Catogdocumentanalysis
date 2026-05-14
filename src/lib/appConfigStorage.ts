import { getDefaultEmbeddingModel, getEmbeddingModelDimension, getEmbeddingScoreThreshold } from './embeddingModels';
import { DEFAULT_GEMINI_PROVIDER_URL } from '../services/geminiModels';
import { DEFAULT_LOCAL_AGENT_MODEL, DEFAULT_LOCAL_AGENT_PROVIDER_URL, resolveAgentProviderType } from '../services/agentProviders';
import { AgentConfig, AppConfig, KnowledgeBase, VisionConfig } from '../types';
import { AGENT_TYPE_PRESETS, CORE_AGENT_ID, DEFAULT_CORE_AGENT_COLOR, DEFAULT_SPECIALIST_COLORS, normalizeAgentColor, resolveAgentType } from './agentConfig';

const APP_CONFIG_STORAGE_KEY = 'catog-app-config-v1';
const DEFAULT_LOCAL_QDRANT_URL = 'http://127.0.0.1:6333';
const DEFAULT_LOCAL_LLAMA_BASE_URL = 'http://127.0.0.1:8080/v1';
const DEFAULT_LOCAL_FALKOR_URL = 'redis://127.0.0.1:6379';

const DEFAULT_VISION_CONFIG: VisionConfig = {
  provider: 'gemini',
  model: 'gemini-2.0-flash',
  baseUrl: '',
  apiKey: '',
  detectorModel: 'Armaggheddon/yolo11-document-layout',
  ocrModel: 'tesseract-5',
};

export const createDefaultAppConfig = (): AppConfig => ({
  agents: {
    core: {
      id: 'core',
      kind: 'core',
      agentType: 'custom',
      providerType: 'openai-compatible',
      order: 0,
      name: 'CORE AI',
      color: DEFAULT_CORE_AGENT_COLOR,
      description: 'Central intelligence with full context flow.',
      role: 'You are CORE AI, the central brain of this Enterprise Intelligence Solution. You have overview of all agents and the Knowledge Base settings. Answer with broad context.',
      apiKey: '',
      providerUrl: DEFAULT_LOCAL_AGENT_PROVIDER_URL,
      model: DEFAULT_LOCAL_AGENT_MODEL,
      kbIds: ['kb1', 'kb2'],
    },
    alpha: {
      id: 'alpha',
      kind: 'specialist',
      agentType: 'auditor',
      providerType: 'openai-compatible',
      order: 1,
      name: 'ALPHA',
      color: DEFAULT_SPECIALIST_COLORS[0],
      description: 'Structural integrity & Auditor specialist.',
      role: 'You are ALPHA, the Auditor Agent. Your focus is strictly on structural integrity, missing clauses, and formal document architecture. Answer based on these domains only.',
      apiKey: '',
      providerUrl: DEFAULT_LOCAL_AGENT_PROVIDER_URL,
      model: DEFAULT_LOCAL_AGENT_MODEL,
      kbIds: ['kb1'],
    },
    sigma: {
      id: 'sigma',
      kind: 'specialist',
      agentType: 'legal',
      providerType: 'openai-compatible',
      order: 2,
      name: 'SIGMA',
      color: DEFAULT_SPECIALIST_COLORS[1],
      description: 'Legal compliance & Jurisdictional expert.',
      role: 'You are SIGMA, the Compliance Agent. Your focus is Jurisdictional compliance, legal risk, and regulatory standards. Answer based on these domains only.',
      apiKey: '',
      providerUrl: DEFAULT_LOCAL_AGENT_PROVIDER_URL,
      model: DEFAULT_LOCAL_AGENT_MODEL,
      kbIds: ['kb1'],
    },
    omega: {
      id: 'omega',
      kind: 'specialist',
      agentType: 'custom',
      providerType: 'openai-compatible',
      order: 3,
      name: 'OMEGA',
      color: DEFAULT_SPECIALIST_COLORS[2],
      description: 'Tone, clarity & sentiment review.',
      role: 'You are OMEGA, the Reviewer Agent. Your focus is Tone, Clarity, Sentiment, and Style. Answer based on these domains only.',
      apiKey: '',
      providerUrl: DEFAULT_LOCAL_AGENT_PROVIDER_URL,
      model: DEFAULT_LOCAL_AGENT_MODEL,
      kbIds: ['kb2'],
    },
  },
  knowledgeBases: [
    {
      id: 'kb1',
      name: 'Enterprise Production DB',
      url: DEFAULT_LOCAL_QDRANT_URL,
      apiKey: '',
      collectionName: 'catog_enterprise_local',
      graphUrl: DEFAULT_LOCAL_FALKOR_URL,
      graphName: 'catog_enterprise_main',
      embedderProvider: 'openai-compatible',
      ragEngine: 'neural',
      embeddingModel: getDefaultEmbeddingModel('openai-compatible'),
      embeddingApiKey: '',
      embeddingBaseUrl: DEFAULT_LOCAL_LLAMA_BASE_URL,
      embeddingModelDimension: getEmbeddingModelDimension('openai-compatible'),
      searchMinScore: getEmbeddingScoreThreshold('openai-compatible'),
      searchMaxResults: 5,
      chunkSize: 500,
      overlap: 10,
    },
    {
      id: 'kb2',
      name: 'Legal Precedent Vault',
      url: DEFAULT_LOCAL_QDRANT_URL,
      apiKey: '',
      collectionName: 'catog_legal_local',
      graphUrl: DEFAULT_LOCAL_FALKOR_URL,
      graphName: 'catog_legal_precedent',
      embedderProvider: 'openai-compatible',
      ragEngine: 'enhanced',
      embeddingModel: getDefaultEmbeddingModel('openai-compatible'),
      embeddingApiKey: '',
      embeddingBaseUrl: DEFAULT_LOCAL_LLAMA_BASE_URL,
      embeddingModelDimension: getEmbeddingModelDimension('openai-compatible'),
      searchMinScore: getEmbeddingScoreThreshold('openai-compatible'),
      searchMaxResults: 5,
      chunkSize: 800,
      overlap: 15,
    },
  ],
  selectedKBIds: ['kb1', 'kb2'],
  vision: DEFAULT_VISION_CONFIG,
});

const mergeAgentConfig = (agentId: string, agent: Partial<AgentConfig>, fallbackAgent?: AgentConfig): AgentConfig => {
  const fallback = fallbackAgent || {
    id: agentId,
    kind: agentId === CORE_AGENT_ID ? 'core' : 'specialist',
    agentType: 'custom',
    providerType: 'openai-compatible',
    order: agentId === CORE_AGENT_ID ? 0 : 99,
    name: agentId.toUpperCase(),
    color: agentId === CORE_AGENT_ID ? DEFAULT_CORE_AGENT_COLOR : DEFAULT_SPECIALIST_COLORS[0],
    description: 'Custom AI agent.',
    role: 'You are a specialist AI agent. Analyze the document carefully and respond with precise findings.',
    apiKey: '',
    providerUrl: DEFAULT_LOCAL_AGENT_PROVIDER_URL,
    model: DEFAULT_LOCAL_AGENT_MODEL,
    kbIds: [],
  } satisfies AgentConfig;

  const agentType = resolveAgentType(agent.agentType || fallback.agentType);
  const preset = AGENT_TYPE_PRESETS[agentType];

  return {
    ...fallback,
    ...agent,
    id: agentId,
    kind: agent.kind === 'core' ? 'core' : fallback.kind,
    agentType,
    providerType: agent.providerType || fallback.providerType,
    order: typeof agent.order === 'number' ? agent.order : fallback.order,
    name: typeof agent.name === 'string' && agent.name.trim().length > 0 ? agent.name : fallback.name,
    color: normalizeAgentColor(agent.color, fallback.color),
    description: agentType === 'custom'
      ? (typeof agent.description === 'string' ? agent.description : fallback.description)
      : preset.description,
    role: agentType === 'custom'
      ? (typeof agent.role === 'string' ? agent.role : fallback.role)
      : preset.role,
    apiKey: typeof agent.apiKey === 'string' ? agent.apiKey : fallback.apiKey,
    providerUrl: typeof agent.providerUrl === 'string' && agent.providerUrl.trim().length > 0 ? agent.providerUrl : fallback.providerUrl,
    model: typeof agent.model === 'string' && agent.model.trim().length > 0 ? agent.model : fallback.model,
    kbIds: Array.isArray(agent.kbIds)
      ? agent.kbIds.filter((knowledgeBaseId): knowledgeBaseId is string => typeof knowledgeBaseId === 'string')
      : fallback.kbIds,
  };
};

const mergeKnowledgeBase = (knowledgeBase: Partial<KnowledgeBase>, fallbackKnowledgeBase?: KnowledgeBase): KnowledgeBase => {
  const fallback = fallbackKnowledgeBase || createDefaultAppConfig().knowledgeBases[0];
  return {
    ...fallback,
    ...knowledgeBase,
    id: knowledgeBase.id || fallback.id,
    name: knowledgeBase.name || fallback.name,
    embedderProvider: knowledgeBase.embedderProvider || fallback.embedderProvider,
    embeddingModel: knowledgeBase.embeddingModel || fallback.embeddingModel,
    ragEngine: knowledgeBase.ragEngine || fallback.ragEngine,
    chunkSize: typeof knowledgeBase.chunkSize === 'number' ? knowledgeBase.chunkSize : fallback.chunkSize,
    overlap: typeof knowledgeBase.overlap === 'number' ? knowledgeBase.overlap : fallback.overlap,
  };
};



const mergeVisionConfig = (vision: Partial<VisionConfig> | undefined, fallbackVision: VisionConfig): VisionConfig => {
  if (!vision) {
    return fallbackVision;
  }

  return {
    provider: 'gemini',
    model: typeof vision.model === 'string' && vision.model.trim().length > 0 ? vision.model : fallbackVision.model,
    baseUrl: typeof vision.baseUrl === 'string' ? vision.baseUrl : fallbackVision.baseUrl,
    apiKey: typeof vision.apiKey === 'string' ? vision.apiKey : fallbackVision.apiKey,
    detectorModel: typeof vision.detectorModel === 'string' && vision.detectorModel.trim().length > 0 ? vision.detectorModel : fallbackVision.detectorModel,
    ocrModel: typeof vision.ocrModel === 'string' && vision.ocrModel.trim().length > 0 ? vision.ocrModel : fallbackVision.ocrModel,
  };
};

export const loadPersistedAppConfig = (defaultConfig: AppConfig): { config: AppConfig; error?: string } => {
  if (typeof window === 'undefined') {
    return { config: defaultConfig };
  }

  const storedValue = window.localStorage.getItem(APP_CONFIG_STORAGE_KEY);
  if (!storedValue) {
    return { config: defaultConfig };
  }

  try {
    const parsedValue = JSON.parse(storedValue) as Partial<AppConfig>;
    const persistedKnowledgeBases = Array.isArray(parsedValue.knowledgeBases)
      ? parsedValue.knowledgeBases.map((knowledgeBase, index) => mergeKnowledgeBase(knowledgeBase, defaultConfig.knowledgeBases[index]))
      : defaultConfig.knowledgeBases;

    const validKnowledgeBaseIds = new Set(persistedKnowledgeBases.map((knowledgeBase) => knowledgeBase.id));
    const selectedKBIds = Array.isArray(parsedValue.selectedKBIds)
      ? parsedValue.selectedKBIds.filter((knowledgeBaseId): knowledgeBaseId is string => typeof knowledgeBaseId === 'string' && validKnowledgeBaseIds.has(knowledgeBaseId))
      : defaultConfig.selectedKBIds;

    return {
      config: {
        agents: (() => {
          const mergedAgents: AppConfig['agents'] = {};
          const parsedAgents = parsedValue.agents && typeof parsedValue.agents === 'object'
            ? Object.entries(parsedValue.agents)
            : [];

          Object.entries(defaultConfig.agents).forEach(([agentId, defaultAgent]) => {
            mergedAgents[agentId] = mergeAgentConfig(agentId, parsedValue.agents?.[agentId] || {}, defaultAgent);
          });

          parsedAgents.forEach(([agentId, parsedAgent], index) => {
            if (mergedAgents[agentId] || !parsedAgent || typeof parsedAgent !== 'object') {
              return;
            }

            mergedAgents[agentId] = mergeAgentConfig(
              agentId,
              parsedAgent as Partial<AgentConfig>,
              {
                ...mergeAgentConfig(agentId, {}, undefined),
                order: Object.keys(defaultConfig.agents).length + index,
                color: DEFAULT_SPECIALIST_COLORS[(Object.keys(defaultConfig.agents).length + index - 1) % DEFAULT_SPECIALIST_COLORS.length],
              },
            );
          });

          if (!mergedAgents[CORE_AGENT_ID]) {
            mergedAgents[CORE_AGENT_ID] = defaultConfig.agents[CORE_AGENT_ID];
          }

          return mergedAgents;
        })(),
        knowledgeBases: persistedKnowledgeBases,
        selectedKBIds: selectedKBIds.length > 0 ? selectedKBIds : defaultConfig.selectedKBIds,
        vision: mergeVisionConfig(parsedValue.vision, defaultConfig.vision),
      },
    };
  } catch (error) {
    return {
      config: defaultConfig,
      error: error instanceof Error
        ? `Stored configuration could not be restored: ${error.message}`
        : 'Stored configuration could not be restored.',
    };
  }
};

export const persistAppConfig = (config: AppConfig): string | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    window.localStorage.setItem(APP_CONFIG_STORAGE_KEY, JSON.stringify(config));
    return null;
  } catch (error) {
    return error instanceof Error
      ? `Configuration persistence failed: ${error.message}`
      : 'Configuration persistence failed.';
  }
};
