/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Database, Cpu, Key, UserCog, Plus, Trash2, BadgeCheck, ChevronDown, Camera, ScrollText, RefreshCw } from 'lucide-react';
import { getDefaultEmbeddingModel, getEmbeddingModelDimension, getEmbeddingScoreThreshold } from '../lib/embeddingModels';
import { AgentConfig, AgentProviderType, AgentType, AppConfig, ChatAgent, EmbeddingProvider, KnowledgeBase, KnowledgeBaseIndexedDocument, KnowledgeBaseIngestionProgress } from '../types';
import { deleteKnowledgeBaseDocuments, ingestKnowledgeBaseFiles, listKnowledgeBaseDocuments, testKnowledgeBaseConnection } from '../services/knowledgeBase';
import { DEFAULT_GEMINI_PROVIDER_URL, verifyGeminiConfiguration } from '../services/geminiModels';
import { DEFAULT_LOCAL_AGENT_MODEL, DEFAULT_LOCAL_AGENT_PROVIDER_URL, resolveAgentProviderType, verifyOpenAiCompatibleConfiguration } from '../services/agentProviders';
import KnowledgeBaseFilesModal from './KnowledgeBaseFilesModal';
import { AGENT_TYPE_PRESETS, applyAgentTypePreset, createSpecialistAgentConfig, DEFAULT_SPECIALIST_COLORS, getAgentTextColor, getOrderedAgents, getSpecialistAgents, isLockedAgentType, normalizeAgentColor, resolveAgentType } from '../lib/agentConfig';
import { DOCUMENT_DETECTOR_SUGGESTIONS, GEMINI_MODEL_SUGGESTIONS, GEMINI_VISION_MODEL_SUGGESTIONS, LOCAL_VISION_MODEL_SUGGESTIONS, OCR_MODEL_SUGGESTIONS } from '../lib/visionModels';
import { getEmbeddingModelOptions } from '../lib/embeddingModels';
import { getGeminiApiKey } from '../lib/runtime';
import { readSystemLog } from '../lib/systemLogger';

interface ConfigurationModalProps {
  isOpen: boolean;
  onClose: () => void;
  config: AppConfig;
  onSave: (config: AppConfig) => void;
  initialTab?: 'agents' | 'kb' | 'vision' | 'logs';
}

export default function ConfigurationModal({
  isOpen,
  onClose,
  config,
  onSave,
  initialTab,
}: ConfigurationModalProps) {
  type KnowledgeBaseIngestionQueueItem = {
    name: string;
    progress: number;
    status: 'queued' | 'ready' | 'embedding' | 'indexing' | 'complete' | 'error';
  };

  type KnowledgeBaseIngestionStateValue = {
    status: 'loading' | 'success' | 'error';
    message: string;
    progress: number;
    fileCount: number;
    processedFiles: number;
    stage?: KnowledgeBaseIngestionProgress['stage'];
    files: KnowledgeBaseIngestionQueueItem[];
  };

  const [localConfig, setLocalConfig] = useState<AppConfig>(config);
  const [activeTab, setActiveTab] = useState<'agents' | 'kb' | 'vision' | 'logs'>(initialTab || 'agents');
  const [systemLogs, setSystemLogs] = useState<string>('');
  const [isLoadingLogs, setIsLoadingLogs] = useState(false);
  const [agentVerificationState, setAgentVerificationState] = useState<Record<string, { status: 'loading' | 'success' | 'error'; message: string; models: string[] } | undefined>>({});
  const [visionVerificationState, setVisionVerificationState] = useState<{ status: 'loading' | 'success' | 'error'; message: string; models: string[] } | undefined>(undefined);

  const [kbConnectionState, setKbConnectionState] = useState<Record<string, { status: 'loading' | 'success' | 'error'; message: string }>>({});
  const [kbIngestionState, setKbIngestionState] = useState<Record<string, KnowledgeBaseIngestionStateValue>>({});
  const [kbDocumentState, setKbDocumentState] = useState<Record<string, {
    status: 'loading' | 'success' | 'error';
    message: string;
    documents: KnowledgeBaseIndexedDocument[];
    selectedFiles: string[];
  }>>({});
  const [expandedKnowledgeBaseIds, setExpandedKnowledgeBaseIds] = useState<string[]>([]);
  const [expandedAgentIds, setExpandedAgentIds] = useState<string[]>([]);
  const [kbDocumentSearch, setKbDocumentSearch] = useState<Record<string, string>>({});
  const [activeKnowledgeBaseDocumentId, setActiveKnowledgeBaseDocumentId] = useState<string | null>(null);

  const orderedAgents = getOrderedAgents(localConfig);
  const specialistAgents = getSpecialistAgents(localConfig);

  useEffect(() => {
    setLocalConfig(config);
    if (isOpen && initialTab) {
      setActiveTab(initialTab);
    }
    setAgentVerificationState({});
    setVisionVerificationState(undefined);
    setKbConnectionState({});
    setKbIngestionState({});
    setKbDocumentState({});
    setExpandedKnowledgeBaseIds([]);
    setExpandedAgentIds([]);
    setKbDocumentSearch({});
    setActiveKnowledgeBaseDocumentId(null);
    setSystemLogs('');
    setIsLoadingLogs(false);
  }, [config, isOpen, initialTab]);

  useEffect(() => {
    if (isOpen && activeTab === 'logs') {
      const fetchLogs = async () => {
        setIsLoadingLogs(true);
        const logs = await readSystemLog();
        setSystemLogs(logs);
        setIsLoadingLogs(false);
      };
      void fetchLogs();
    }
  }, [isOpen, activeTab]);

  if (!isOpen) return null;

  const handleSave = () => {
    onSave(localConfig);
    onClose();
  };

  const addSpecialistAgent = () => {
    const nextSpecialistIndex = specialistAgents.length + 1;
    const templateAgent = specialistAgents[specialistAgents.length - 1];
    const newAgent = createSpecialistAgentConfig(nextSpecialistIndex, {
      providerType: templateAgent?.providerType || localConfig.agents.core?.providerType || 'openai-compatible',
      providerUrl: templateAgent?.providerUrl || localConfig.agents.core?.providerUrl || DEFAULT_LOCAL_AGENT_PROVIDER_URL,
      model: templateAgent?.model || localConfig.agents.core?.model || DEFAULT_LOCAL_AGENT_MODEL,
      kbIds: templateAgent?.kbIds || localConfig.selectedKBIds,
      name: `SPECIALIST ${nextSpecialistIndex}`,
      description: `Custom neon specialist ${nextSpecialistIndex}.`,
      color: DEFAULT_SPECIALIST_COLORS[(nextSpecialistIndex - 1) % DEFAULT_SPECIALIST_COLORS.length],
      order: nextSpecialistIndex,
    });

    setLocalConfig({
      ...localConfig,
      agents: {
        ...localConfig.agents,
        [newAgent.id]: newAgent,
      },
    });
  };

  const toggleAgentExpanded = (agentId: string) => {
    setExpandedAgentIds((prev) =>
      prev.includes(agentId) ? prev.filter((id) => id !== agentId) : [...prev, agentId]
    );
  };

  const removeAgent = (agentId: string) => {
    const targetAgent = localConfig.agents[agentId];
    if (!targetAgent || targetAgent.kind === 'core' || specialistAgents.length <= 1) {
      return;
    }

    setLocalConfig({
      ...localConfig,
      agents: Object.fromEntries(
        Object.entries(localConfig.agents).filter(([id]) => id !== agentId),
      ),
    });

    setAgentVerificationState((currentState) => {
      const { [agentId]: _removed, ...rest } = currentState;
      return rest;
    });
  };

  const addKB = () => {
    const newKB: KnowledgeBase = {
      id: Math.random().toString(36).substr(2, 9),
      name: `New Knowledge Base ${localConfig.knowledgeBases.length + 1}`,
      url: 'http://127.0.0.1:6333',
      apiKey: '',
      collectionName: `catog_local_${localConfig.knowledgeBases.length + 1}`,
      graphUrl: 'redis://127.0.0.1:6379',
      graphName: `catog_${localConfig.knowledgeBases.length + 1}`,
      embedderProvider: 'openai-compatible',
      ragEngine: 'neural',
      embeddingModel: getDefaultEmbeddingModel('openai-compatible'),
      embeddingApiKey: '',
      embeddingBaseUrl: 'http://127.0.0.1:8080/v1',
      embeddingModelDimension: getEmbeddingModelDimension('openai-compatible'),
      searchMinScore: getEmbeddingScoreThreshold('openai-compatible'),
      searchMaxResults: 5,
      chunkSize: 500,
      overlap: 10,
      graphExtractionProvider: 'heuristic',
      graphExtractionModel: '',
      graphExtractionApiKey: '',
      graphExtractionBaseUrl: '',
    };
    setLocalConfig({
      ...localConfig,
      knowledgeBases: [...localConfig.knowledgeBases, newKB]
    });
    setExpandedKnowledgeBaseIds((currentState) => [...new Set([...currentState, newKB.id])]);
  };

  const removeKB = (id: string) => {
    if (localConfig.knowledgeBases.length <= 1) return;
    setLocalConfig({
      ...localConfig,
      knowledgeBases: localConfig.knowledgeBases.filter(kb => kb.id !== id),
      selectedKBIds: localConfig.selectedKBIds.filter(kbId => kbId !== id)
    });
    setExpandedKnowledgeBaseIds((currentState) => currentState.filter((kbId) => kbId !== id));
    setActiveKnowledgeBaseDocumentId((currentState) => (currentState === id ? null : currentState));
  };

  const updateAgent = <K extends keyof AgentConfig>(agentId: ChatAgent, field: K, value: AgentConfig[K]) => {
    setLocalConfig({
      ...localConfig,
      agents: {
        ...localConfig.agents,
        [agentId]: {
          ...localConfig.agents[agentId],
          [field]: value,
        }
      }
    });
  };

  const updateVisionConfig = <K extends keyof AppConfig['vision']>(field: K, value: AppConfig['vision'][K]) => {
    const nextVision = {
      ...localConfig.vision,
      [field]: value,
    };

    if (field === 'provider') {
      if (value === 'gemini') {
        nextVision.model = GEMINI_VISION_MODEL_SUGGESTIONS[0];
      } else if (value === 'openai-compatible') {
        nextVision.model = LOCAL_VISION_MODEL_SUGGESTIONS[0];
      }
    }

    setLocalConfig({
      ...localConfig,
      vision: nextVision,
    });
  };

  const updateAgentType = (agentId: ChatAgent, type: AgentType) => {
    const preset = AGENT_TYPE_PRESETS[type];
    setLocalConfig({
      ...localConfig,
      agents: {
        ...localConfig.agents,
        [agentId]: {
          ...localConfig.agents[agentId],
          agentType: type,
          role: preset.role,
          description: preset.description,
        }
      }
    });
  };

  const updateAgentProviderType = (agentId: ChatAgent, providerType: AgentProviderType) => {
    const nextAgent = { 
      ...localConfig.agents[agentId],
      providerType,
    };
    
    if (providerType === 'openai-compatible') {
      nextAgent.providerUrl = DEFAULT_LOCAL_AGENT_PROVIDER_URL;
      nextAgent.model = DEFAULT_LOCAL_AGENT_MODEL;
    } else {
      nextAgent.providerUrl = DEFAULT_GEMINI_PROVIDER_URL;
      nextAgent.model = GEMINI_MODEL_SUGGESTIONS[0];
    }

    setLocalConfig({
      ...localConfig,
      agents: {
        ...localConfig.agents,
        [agentId]: nextAgent,
      }
    });
  };

  const toggleAgentKB = (agentId: ChatAgent, kbId: string) => {
    const agent = localConfig.agents[agentId];
    const currentIds = agent.kbIds || [];
    const nextIds = currentIds.includes(kbId)
      ? currentIds.filter(id => id !== kbId)
      : [...currentIds, kbId];

    updateAgent(agentId, 'kbIds', nextIds);
  };



  const handleVerifyAgent = async (agentId: ChatAgent) => {
    const agentConfig = localConfig.agents[agentId];
    const providerType = resolveAgentProviderType(agentConfig);

    setAgentVerificationState((currentState) => ({
      ...currentState,
      [agentId]: {
        status: 'loading',
        message: providerType === 'openai-compatible'
          ? 'Checking the local AI endpoint and loading available models...'
          : 'Verifying Gemini access and loading available models...',
        models: [],
      },
    }));

    try {
      if (providerType === 'openai-compatible') {
        const result = await verifyOpenAiCompatibleConfiguration(agentConfig.providerUrl, agentConfig.apiKey);
        const selectedModel = agentConfig.model || result.models[0] || DEFAULT_LOCAL_AGENT_MODEL;
        updateAgent(agentId, 'model', selectedModel);
        setAgentVerificationState((currentState) => ({
          ...currentState,
          [agentId]: {
            status: 'success',
            message: result.message,
            models: result.models.length > 0 ? result.models : [selectedModel],
          },
        }));
        return;
      }

      if (providerType === 'gemini') {
        const apiKey = agentConfig.apiKey;
        if (!apiKey) {
          setAgentVerificationState((currentState) => ({
            ...currentState,
            [agentId]: { status: 'error', message: 'A Gemini API key is required for verification.', models: [] },
          }));
          return;
        }

        const result = await verifyGeminiConfiguration(apiKey, agentConfig.providerUrl);
        const selectedModel = agentConfig.model || result.models[0];
        updateAgent(agentId, 'model', selectedModel);
        setAgentVerificationState((currentState) => ({
          ...currentState,
          [agentId]: {
            status: 'success',
            message: result.message,
            models: result.models,
          },
        }));
      }
    } catch (error) {
      setAgentVerificationState((currentState) => ({
        ...currentState,
        [agentId]: { status: 'error', message: error instanceof Error ? error.message : 'Agent verification failed.', models: [] },
      }));
    }
  };

  const handleVerifyVision = async () => {
    const apiKey = localConfig.vision.apiKey;
    if (localConfig.vision.provider === 'gemini' && !apiKey) {
      setVisionVerificationState({ status: 'error', message: 'A Gemini API key is required for verification.', models: [] });
      return;
    }

    setVisionVerificationState({
      status: 'loading',
      message: 'Verifying Vision API access and loading models...',
      models: [],
    });

    try {
      if (localConfig.vision.provider === 'gemini') {
        const result = await verifyGeminiConfiguration(apiKey, localConfig.vision.baseUrl);
        const selectedModel = localConfig.vision.model || result.models.find(m => m.includes('flash')) || result.models[0];
        
        setLocalConfig({
          ...localConfig,
          vision: {
            ...localConfig.vision,
            model: selectedModel,
          }
        });

        setVisionVerificationState({
          status: 'success',
          message: result.message,
          models: result.models,
        });
      } else {
        const baseUrl = localConfig.vision.baseUrl || 'http://127.0.0.1:8001/v1';
        const result = await verifyOpenAiCompatibleConfiguration(baseUrl, apiKey);
        const selectedModel = localConfig.vision.model || result.models[0] || LOCAL_VISION_MODEL_SUGGESTIONS[0];
        
        setLocalConfig({
          ...localConfig,
          vision: {
            ...localConfig.vision,
            model: selectedModel,
          }
        });

        setVisionVerificationState({
          status: 'success',
          message: result.message,
          models: result.models,
        });
      }
    } catch (error) {
      setVisionVerificationState({
        status: 'error',
        message: error instanceof Error ? error.message : 'Vision verification failed.',
        models: [],
      });
    }
  };

  const toggleGlobalKB = (kbId: string) => {
    const currentIds = localConfig.selectedKBIds;
    const newIds = currentIds.includes(kbId)
      ? (currentIds.length > 1 ? currentIds.filter(id => id !== kbId) : currentIds)
      : [...currentIds, kbId];

    setLocalConfig({
      ...localConfig,
      selectedKBIds: newIds
    });
  };

  const updateKB = (kbId: string, field: keyof KnowledgeBase, value: any) => {
    setLocalConfig({
      ...localConfig,
      knowledgeBases: localConfig.knowledgeBases.map(kb =>
        kb.id === kbId ? { ...kb, [field]: value } : kb
      )
    });
  };

  const updateEmbeddingProvider = (kbId: string, provider: EmbeddingProvider) => {
    const defaultModel = getDefaultEmbeddingModel(provider);
    setLocalConfig({
      ...localConfig,
      knowledgeBases: localConfig.knowledgeBases.map((kb) =>
        kb.id === kbId
          ? {
            ...kb,
            embedderProvider: provider,
            embeddingModel: defaultModel,
            embeddingModelDimension: getEmbeddingModelDimension(provider, defaultModel),
            searchMinScore: getEmbeddingScoreThreshold(provider, defaultModel),
            embeddingBaseUrl: provider === 'openai-compatible' ? kb.embeddingBaseUrl || 'https://' : '',
          }
          : kb,
      ),
    });
  };

  const updateEmbeddingModel = (kbId: string, provider: EmbeddingProvider, modelId: string) => {
    updateKB(kbId, 'embeddingModel', modelId);

    const resolvedDimension = getEmbeddingModelDimension(provider, modelId);
    if (resolvedDimension) {
      updateKB(kbId, 'embeddingModelDimension', resolvedDimension);
    }

    const resolvedThreshold = getEmbeddingScoreThreshold(provider, modelId);
    if (resolvedThreshold !== undefined) {
      updateKB(kbId, 'searchMinScore', resolvedThreshold);
    }
  };

  const handleTestConnection = async (knowledgeBase: KnowledgeBase) => {
    setKbConnectionState((currentState) => ({
      ...currentState,
      [knowledgeBase.id]: {
        status: 'loading',
        message: 'Testing Qdrant, embeddings, and FalkorDB connectivity...',
      },
    }));

    try {
      const result = await testKnowledgeBaseConnection(knowledgeBase);
      setKbConnectionState((currentState) => ({
        ...currentState,
        [knowledgeBase.id]: {
          status: 'success',
          message: result.message,
        },
      }));
    } catch (error) {
      setKbConnectionState((currentState) => ({
        ...currentState,
        [knowledgeBase.id]: {
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        },
      }));
    }
  };

  const handleKnowledgeBaseUpload = async (knowledgeBase: KnowledgeBase, files: FileList | null) => {
    if (!files || files.length === 0) {
      return;
    }

    const selectedFiles = Array.from(files);
    setKbIngestionState((currentState) => ({
      ...currentState,
      [knowledgeBase.id]: {
        status: 'loading',
        message: `Preparing ${selectedFiles.length} file(s) for embedding...`,
        progress: 5,
        fileCount: selectedFiles.length,
        processedFiles: 0,
        stage: 'reading',
        files: buildIngestionQueue(selectedFiles.map((file) => file.name), 'reading', 0, 'loading'),
      },
    }));

    try {
      const result = await ingestKnowledgeBaseFiles(
        localConfig,
        knowledgeBase,
        selectedFiles,
        (progress) => {
          setKbIngestionState((currentState) => ({
            ...currentState,
            [knowledgeBase.id]: {
              status: 'loading',
              message: progress.message,
              progress: progress.progress,
              fileCount: progress.totalFiles,
              processedFiles: progress.processedFiles,
              stage: progress.stage,
              files: buildIngestionQueue(selectedFiles.map((file) => file.name), progress.stage, progress.processedFiles, 'loading'),
            },
          }));
        },
      );
      setKbIngestionState((currentState) => ({
        ...currentState,
        [knowledgeBase.id]: {
          status: 'success',
          message: result.message,
          progress: 100,
          fileCount: selectedFiles.length,
          processedFiles: selectedFiles.length,
          stage: 'complete',
          files: buildIngestionQueue(selectedFiles.map((file) => file.name), 'complete', selectedFiles.length, 'success'),
        },
      }));
      await handleViewKnowledgeBaseDocuments(knowledgeBase);
    } catch (error) {
      setKbIngestionState((currentState) => ({
        ...currentState,
        [knowledgeBase.id]: {
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
          progress: currentState[knowledgeBase.id]?.progress ?? 0,
          fileCount: selectedFiles.length,
          processedFiles: currentState[knowledgeBase.id]?.processedFiles ?? 0,
          stage: currentState[knowledgeBase.id]?.stage,
          files: buildIngestionQueue(
            selectedFiles.map((file) => file.name),
            currentState[knowledgeBase.id]?.stage,
            currentState[knowledgeBase.id]?.processedFiles ?? 0,
            'error',
          ),
        },
      }));
    }
  };

  const handleViewKnowledgeBaseDocuments = async (knowledgeBase: KnowledgeBase) => {
    setKbDocumentState((currentState) => ({
      ...currentState,
      [knowledgeBase.id]: {
        status: 'loading',
        message: 'Loading embedded files...',
        documents: currentState[knowledgeBase.id]?.documents || [],
        selectedFiles: currentState[knowledgeBase.id]?.selectedFiles || [],
      },
    }));

    try {
      const documents = await listKnowledgeBaseDocuments(knowledgeBase);
      setKbDocumentState((currentState) => ({
        ...currentState,
        [knowledgeBase.id]: {
          status: 'success',
          message: documents.length > 0
            ? `Loaded ${documents.length} embedded file(s).`
            : 'No embedded files were found in this collection yet.',
          documents,
          selectedFiles: [],
        },
      }));
    } catch (error) {
      setKbDocumentState((currentState) => ({
        ...currentState,
        [knowledgeBase.id]: {
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
          documents: currentState[knowledgeBase.id]?.documents || [],
          selectedFiles: currentState[knowledgeBase.id]?.selectedFiles || [],
        },
      }));
    }
  };

  const handleOpenKnowledgeBaseDocuments = (knowledgeBase: KnowledgeBase) => {
    setActiveKnowledgeBaseDocumentId(knowledgeBase.id);
    void handleViewKnowledgeBaseDocuments(knowledgeBase);
  };

  const toggleKnowledgeBaseExpanded = (knowledgeBaseId: string) => {
    setExpandedKnowledgeBaseIds((currentState) => (
      currentState.includes(knowledgeBaseId)
        ? currentState.filter((kbId) => kbId !== knowledgeBaseId)
        : [...currentState, knowledgeBaseId]
    ));
  };

  const toggleKnowledgeBaseDocumentSelection = (knowledgeBaseId: string, fileName: string) => {
    setKbDocumentState((currentState) => {
      const currentSelection = currentState[knowledgeBaseId]?.selectedFiles || [];
      const nextSelection = currentSelection.includes(fileName)
        ? currentSelection.filter((selectedFile) => selectedFile !== fileName)
        : [...currentSelection, fileName];

      return {
        ...currentState,
        [knowledgeBaseId]: {
          ...(currentState[knowledgeBaseId] || {
            status: 'success',
            message: '',
            documents: [],
            selectedFiles: [],
          }),
          selectedFiles: nextSelection,
        },
      };
    });
  };

  const setKnowledgeBaseDocumentSearch = (knowledgeBaseId: string, value: string) => {
    setKbDocumentSearch((currentState) => ({
      ...currentState,
      [knowledgeBaseId]: value,
    }));
  };

  const toggleKnowledgeBaseDocumentSelectionBatch = (
    knowledgeBaseId: string,
    fileNames: string[],
    shouldSelect: boolean,
  ) => {
    setKbDocumentState((currentState) => {
      const currentSelection = new Set(currentState[knowledgeBaseId]?.selectedFiles || []);
      fileNames.forEach((fileName) => {
        if (shouldSelect) {
          currentSelection.add(fileName);
        } else {
          currentSelection.delete(fileName);
        }
      });

      return {
        ...currentState,
        [knowledgeBaseId]: {
          ...(currentState[knowledgeBaseId] || {
            status: 'success',
            message: '',
            documents: [],
            selectedFiles: [],
          }),
          selectedFiles: Array.from(currentSelection),
        },
      };
    });
  };

  const handleDeleteKnowledgeBaseDocuments = async (knowledgeBase: KnowledgeBase) => {
    const selectedFiles = kbDocumentState[knowledgeBase.id]?.selectedFiles || [];
    if (selectedFiles.length === 0) {
      return;
    }

    setKbDocumentState((currentState) => ({
      ...currentState,
      [knowledgeBase.id]: {
        ...(currentState[knowledgeBase.id] || {
          status: 'success',
          message: '',
          documents: [],
          selectedFiles: [],
        }),
        status: 'loading',
        message: `Deleting ${selectedFiles.length} embedded file(s)...`,
      },
    }));

    try {
      const result = await deleteKnowledgeBaseDocuments(knowledgeBase, selectedFiles);
      await handleViewKnowledgeBaseDocuments(knowledgeBase);
      setKbIngestionState((currentState) => ({
        ...currentState,
        [knowledgeBase.id]: {
          status: 'success',
          message: result.message,
          progress: 100,
          fileCount: selectedFiles.length,
          processedFiles: selectedFiles.length,
          stage: 'complete',
          files: buildIngestionQueue(selectedFiles, 'complete', selectedFiles.length, 'success'),
        },
      }));
    } catch (error) {
      setKbDocumentState((currentState) => ({
        ...currentState,
        [knowledgeBase.id]: {
          ...(currentState[knowledgeBase.id] || {
            status: 'error',
            message: '',
            documents: [],
            selectedFiles,
          }),
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        },
      }));
    }
  };

  const activeKnowledgeBaseDocument = activeKnowledgeBaseDocumentId
    ? localConfig.knowledgeBases.find((knowledgeBase) => knowledgeBase.id === activeKnowledgeBaseDocumentId) || null
    : null;

  const formatIngestionStage = (stage?: KnowledgeBaseIngestionProgress['stage']) => {
    switch (stage) {
      case 'reading':
        return 'Reading files';
      case 'embedding':
        return 'Embedding vectors';
      case 'indexing':
        return 'Indexing graph';
      case 'complete':
        return 'Complete';
      default:
        return 'Pending';
    }
  };

  const formatQueueStatus = (status: KnowledgeBaseIngestionQueueItem['status']) => {
    switch (status) {
      case 'queued':
        return 'Queued';
      case 'ready':
        return 'Ready';
      case 'embedding':
        return 'Embedding';
      case 'indexing':
        return 'Indexing';
      case 'complete':
        return 'Complete';
      case 'error':
        return 'Error';
      default:
        return status;
    }
  };

  const buildIngestionQueue = (
    fileNames: string[],
    stage: KnowledgeBaseIngestionProgress['stage'] | undefined,
    processedFiles: number,
    overallStatus: KnowledgeBaseIngestionStateValue['status'],
  ): KnowledgeBaseIngestionQueueItem[] => (
    fileNames.map((fileName, index) => {
      if (overallStatus === 'error') {
        return {
          name: fileName,
          progress: index < processedFiles ? 100 : 0,
          status: index < processedFiles ? 'complete' : 'error',
        };
      }

      if (stage === 'complete') {
        return {
          name: fileName,
          progress: 100,
          status: 'complete',
        };
      }

      if (stage === 'indexing') {
        return {
          name: fileName,
          progress: 90,
          status: 'indexing',
        };
      }

      if (stage === 'embedding') {
        return {
          name: fileName,
          progress: 72,
          status: 'embedding',
        };
      }

      if (stage === 'reading') {
        return {
          name: fileName,
          progress: index < processedFiles ? 40 : 0,
          status: index < processedFiles ? 'ready' : 'queued',
        };
      }

      return {
        name: fileName,
        progress: 0,
        status: 'queued',
      };
    })
  );

  return (
    <AnimatePresence>
      <>
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/90 backdrop-blur-md">
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            className="bg-[#0D0D0F] w-full max-w-4xl h-[80vh] rounded-xl border border-white/10 shadow-2xl overflow-hidden flex flex-col"
          >
            {/* Header */}
            <div className="p-6 border-b border-white/10 flex items-center justify-between bg-[#161618]">
              <div className="flex items-center space-x-3">
                <UserCog size={20} className="text-neon-pink" />
                <h2 className="text-sm font-black uppercase tracking-[0.2em] text-white">System Configuration</h2>
              </div>
              <button onClick={onClose} className="text-white/40 hover:text-white transition-colors">
                <X size={20} />
              </button>
            </div>

            <div className="flex-1 flex overflow-hidden">
              {/* Sidebar Tabs */}
              <div className="w-48 border-r border-white/10 bg-black/20 p-4 space-y-2">
                <button
                  onClick={() => setActiveTab('agents')}
                  className={`w-full flex items-center space-x-3 px-4 py-3 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all
                  ${activeTab === 'agents' ? 'bg-neon-pink text-white' : 'text-white/40 hover:bg-white/5 hover:text-white'}
                `}
                >
                  <Cpu size={14} />
                  <span>AI Agents</span>
                </button>
                <button
                  onClick={() => setActiveTab('kb')}
                  className={`w-full flex items-center space-x-3 px-4 py-3 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all
                  ${activeTab === 'kb' ? 'bg-neon-cyan text-black' : 'text-white/40 hover:bg-white/5 hover:text-white'}
                `}
                >
                  <Database size={14} />
                  <span>Knowledge Base</span>
                </button>
                <button
                  onClick={() => setActiveTab('vision')}
                  className={`w-full flex items-center space-x-3 px-4 py-3 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all
                  ${activeTab === 'vision' ? 'bg-neon-violet text-white' : 'text-white/40 hover:bg-white/5 hover:text-white'}
                `}
                >
                  <Camera size={14} />
                  <span>Vision Intake</span>
                </button>

                <button
                  onClick={() => setActiveTab('logs')}
                  className={`w-full flex items-center space-x-3 px-4 py-3 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all
                  ${activeTab === 'logs' ? 'bg-neon-yellow text-black shadow-[0_0_15px_rgba(255,255,0,0.3)]' : 'text-white/40 hover:bg-white/5 hover:text-white'}
                `}
                >
                  <ScrollText size={14} />
                  <span>System Logs</span>
                </button>

              </div>

              {/* Content Area */}
              <div className="flex-1 overflow-y-auto p-8 custom-scrollbar">



                {activeTab === 'vision' && (
                  <div className="mb-8 rounded-xl border border-white/10 bg-black/20 p-5">
                    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                      <div className="space-y-2 lg:col-span-2">
                        <div className="text-[10px] font-black uppercase tracking-widest text-neon-pink">Vision Intake Models</div>
                        <div className="text-xs text-white/45">
                          Camera captures can be processed via local models (Gemma/Qwen) or Gemini Vision. Local models are recommended for privacy, while Gemini offers superior extraction quality.
                        </div>
                      </div>
                      <div className="space-y-2 col-span-full">
                        <label className="text-[10px] font-black text-white/40 uppercase tracking-widest flex items-center justify-between">
                          <span>Vision API Token (Optional)</span>
                          {visionVerificationState?.status === 'success' && (
                            <span className="text-[9px] text-success-green flex items-center gap-1 normal-case font-medium">
                              <BadgeCheck size={10} /> Verified {visionVerificationState.models.length} models
                            </span>
                          )}
                        </label>
                        <div className="flex gap-2">
                          <input
                            type="password"
                            value={localConfig.vision.apiKey}
                            onChange={(e) => updateVisionConfig('apiKey', e.target.value)}
                            placeholder={localConfig.vision.provider === 'gemini' ? "Enter Gemini API key..." : "Enter dedicated API key for local vision..."}
                            className="flex-1 bg-black/40 border border-white/10 rounded px-4 py-2 text-xs text-white outline-none focus:border-neon-violet transition-all font-mono"
                          />
                          <button
                            onClick={handleVerifyVision}
                            disabled={visionVerificationState?.status === 'loading'}
                            className={`px-4 py-2 rounded text-[10px] font-black uppercase tracking-widest transition-all ${visionVerificationState?.status === 'loading'
                                ? 'bg-white/5 text-white/20 cursor-not-allowed'
                                : visionVerificationState?.status === 'error'
                                  ? 'bg-error-red/20 text-error-red border border-error-red/30 hover:bg-error-red/30'
                                  : 'bg-neon-violet/20 text-neon-violet border border-neon-violet/30 hover:bg-neon-violet/30'
                              }`}
                          >
                            {visionVerificationState?.status === 'loading' ? 'Verifying...' : 'Verify'}
                          </button>
                        </div>
                        {visionVerificationState?.status === 'error' && (
                          <p className="text-[9px] text-error-red mt-1 italic">{visionVerificationState.message}</p>
                        )}
                      </div>
                      <div className="space-y-2 col-span-full">
                        <label className="text-[10px] font-black text-white/40 uppercase tracking-widest">Vision Provider</label>
                        <select
                          value={localConfig.vision.provider}
                          onChange={(e) => updateVisionConfig('provider', e.target.value as any)}
                          className="w-full bg-black/40 border border-white/10 rounded px-4 py-2 text-xs text-white outline-none focus:border-neon-violet transition-all"
                        >
                          <option value="gemini">Google Gemini (Cloud)</option>
                          <option value="openai-compatible">OpenAI Compatible (Local)</option>
                        </select>
                      </div>
                      <div className="space-y-2 col-span-full">
                        <label className="text-[10px] font-black text-white/40 uppercase tracking-widest">Vision Provider URL</label>
                        <input
                          type="text"
                          value={localConfig.vision.baseUrl}
                          onChange={(e) => updateVisionConfig('baseUrl', e.target.value)}
                          placeholder={localConfig.vision.provider === 'gemini' ? "Default: https://generativelanguage.googleapis.com/v1beta" : "http://127.0.0.1:8001/v1"}
                          className="w-full bg-black/40 border border-white/10 rounded px-4 py-2 text-xs text-white outline-none focus:border-neon-violet transition-all font-mono"
                        />
                        <p className="text-[9px] text-white/30 italic">
                          {localConfig.vision.provider === 'gemini' ? 'Leave blank to use the standard Gemini endpoint.' : 'Endpoint for your local vision server.'}
                        </p>
                      </div>
                      <div className="space-y-2 col-span-full">
                        <label className="text-[10px] font-black text-white/40 uppercase tracking-widest">Vision Model</label>
                        <input
                          type="text"
                          value={localConfig.vision.model}
                          onChange={(e) => updateVisionConfig('model', e.target.value)}
                          placeholder="Select or type a model name..."
                          className="w-full bg-black/40 border border-white/10 rounded px-4 py-2 text-xs text-white outline-none focus:border-neon-violet transition-all font-mono"
                        />

                        {visionVerificationState?.status === 'success' && (
                          <div className="mt-3 space-y-2">
                            <div className="text-[9px] font-black text-white/20 uppercase tracking-widest">All Verified Models ({visionVerificationState.models.length})</div>
                            <div className="grid grid-cols-2 md:grid-cols-3 gap-2 max-h-40 overflow-y-auto pr-2 custom-scrollbar">
                              {visionVerificationState.models.map((model) => (
                                <button
                                  key={model}
                                  onClick={() => updateVisionConfig('model', model)}
                                  className={`px-3 py-1.5 rounded text-[10px] text-left transition-all border ${localConfig.vision.model === model
                                      ? 'bg-neon-violet/20 border-neon-violet text-white font-bold'
                                      : 'bg-white/5 border-white/5 text-white/50 hover:bg-white/10 hover:border-white/10'
                                    }`}
                                >
                                  {model}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}

                        {!visionVerificationState && (
                          <div className="mt-3 flex flex-wrap gap-2">
                            {(localConfig.vision.provider === 'gemini' ? GEMINI_VISION_MODEL_SUGGESTIONS : LOCAL_VISION_MODEL_SUGGESTIONS).map((model) => (
                              <button
                                key={model}
                                onClick={() => updateVisionConfig('model', model)}
                                className={`px-3 py-1.5 rounded text-[10px] transition-all border ${localConfig.vision.model === model
                                    ? 'bg-neon-violet/20 border-neon-violet text-white font-bold'
                                    : 'bg-white/5 border-white/5 text-white/50 hover:bg-white/10 hover:border-white/10'
                                  }`}
                              >
                                {model}
                              </button>
                            ))}
                          </div>
                        )}

                        <p className="text-[9px] text-white/30 italic mt-2">
                          Select a model from the verified list above. Click <b>Verify</b> to refresh the list of all {visionVerificationState?.models.length || 33}+ models available to your API key.
                        </p>
                      </div>
                      <div className="space-y-2">
                        <label className="text-[10px] font-black text-white/40 uppercase tracking-widest">Document Detector Suggestion</label>
                        <input
                          type="text"
                          list="vision-detector-suggestions"
                          value={localConfig.vision.detectorModel}
                          onChange={(e) => updateVisionConfig('detectorModel', e.target.value)}
                          className="w-full bg-black/40 border border-white/10 rounded px-4 py-2 text-xs text-white outline-none focus:border-neon-violet transition-all font-mono"
                        />
                        <datalist id="vision-detector-suggestions">
                          {DOCUMENT_DETECTOR_SUGGESTIONS.map((model) => (
                            <option key={model} value={model} />
                          ))}
                        </datalist>
                      </div>
                      <div className="space-y-2">
                        <label className="text-[10px] font-black text-white/40 uppercase tracking-widest">OCR Suggestion</label>
                        <input
                          type="text"
                          list="vision-ocr-suggestions"
                          value={localConfig.vision.ocrModel}
                          onChange={(e) => updateVisionConfig('ocrModel', e.target.value)}
                          className="w-full bg-black/40 border border-white/10 rounded px-4 py-2 text-xs text-white outline-none focus:border-neon-violet transition-all font-mono"
                        />
                        <datalist id="vision-ocr-suggestions">
                          {OCR_MODEL_SUGGESTIONS.map((model) => (
                            <option key={model} value={model} />
                          ))}
                        </datalist>
                      </div>
                      <div className="lg:col-span-2 rounded-lg border border-white/10 bg-black/30 px-4 py-3 text-[10px] leading-relaxed text-white/55">
                        Live vision stack: <span className="text-neon-cyan">Armaggheddon/yolo11-document-layout</span> for camera document finding, <span className="text-neon-cyan">opencv-document-quad</span> for perspective crops, and <span className="text-neon-violet">Gemini Vision</span> for document extraction. Local AI models (Gemma/Qwen) remain available for knowledge base and agent specialist tasks.
                      </div>
                    </div>
                  </div>
                )}

                {activeTab === 'agents' && (
                  <div className="space-y-10">
                    <div className="flex items-center justify-between rounded-xl border border-white/10 bg-black/20 px-4 py-3">
                      <div>
                        <div className="text-[10px] font-black uppercase tracking-[0.25em] text-white/50">Agent Lineup</div>
                        <div className="mt-1 text-xs text-white/35">
                          Rename agents, assign neon colors, and add more specialists to the execution pipeline.
                        </div>
                      </div>
                      <button
                        onClick={addSpecialistAgent}
                        className="inline-flex items-center gap-2 rounded border border-neon-cyan/30 bg-neon-cyan/10 px-4 py-2 text-[10px] font-black uppercase tracking-widest text-neon-cyan transition-all hover:bg-neon-cyan/20"
                      >
                        <Plus size={12} />
                        Add Specialist
                      </button>
                    </div>

                    {orderedAgents.map((agent) => {
                      const Icon = Cpu;
                      const agentTextColor = getAgentTextColor(agent.color);
                      const resolvedAgentType = resolveAgentType(agent.agentType);
                      const isPromptLocked = isLockedAgentType(resolvedAgentType);
                      const agentTypeLabel = AGENT_TYPE_PRESETS[resolvedAgentType].label;
                      const providerType = resolveAgentProviderType(agent);
                      const providerUrlLabel = providerType === 'openai-compatible' ? 'Local AI Base URL' : 'Gemini Provider URL';
                      const modelLabel = providerType === 'openai-compatible' ? 'Local AI Model' : 'Gemini Model';
                      const verificationButtonLabel = providerType === 'openai-compatible' ? 'Verify Local AI' : 'Verify Gemini Access';
                      const verificationPlaceholder = providerType === 'openai-compatible' ? 'Verify local AI to load models' : 'Verify Gemini access to load models';

                      const isExpanded = expandedAgentIds.includes(agent.id);

                      return (
                        <div
                          key={agent.id}
                          className={`p-6 rounded-xl border transition-all duration-500
                        ${isExpanded ? 'border-neon-pink/20 bg-neon-pink/[0.02]' : 'border-white/5 bg-white/[0.01] hover:bg-white/[0.02]'}
                      `}
                        >
                          <div
                            onClick={() => toggleAgentExpanded(agent.id)}
                            className="cursor-pointer"
                          >
                            <div className="flex items-center justify-between gap-4">
                              <div className="flex items-center space-x-3">
                                <span
                                  className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 shadow-[0_0_18px_rgba(255,255,255,0.08)] transition-all"
                                  style={{ backgroundColor: agent.color, color: agentTextColor }}
                                >
                                  <Icon size={16} />
                                </span>
                                <div>
                                  <h3 className="text-xs font-black uppercase tracking-widest text-white">{agent.name}</h3>
                                  <p className="mt-1 text-[10px] uppercase tracking-widest text-white/25">
                                    {agent.kind === 'core' ? 'Core Synthesis' : `Specialist Agent`} — {agentTypeLabel}
                                  </p>
                                </div>
                              </div>

                              <div className="flex items-center space-x-4">
                                <div className="hidden md:flex flex-col items-end mr-4">
                                  <span className="text-[9px] font-black uppercase tracking-widest text-white/40">{providerType === 'gemini' ? 'Gemini' : 'Local AI'}</span>
                                  <span className="text-[8px] text-white/20 font-mono truncate max-w-[120px]">{agent.model}</span>
                                </div>
                                <button
                                  type="button"
                                  className={`rounded-full border p-1.5 transition-all ${isExpanded
                                      ? 'border-neon-pink/40 bg-neon-pink/10 text-neon-pink'
                                      : 'border-white/10 bg-white/5 text-white/45'
                                    }`}
                                >
                                  <ChevronDown
                                    size={14}
                                    className={`transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                                  />
                                </button>
                              </div>
                            </div>
                          </div>

                          <AnimatePresence initial={false}>
                            {isExpanded && (
                              <motion.div
                                initial={{ height: 0, opacity: 0 }}
                                animate={{ height: 'auto', opacity: 1 }}
                                exit={{ height: 0, opacity: 0 }}
                                transition={{ duration: 0.2, ease: 'easeOut' }}
                                className="overflow-hidden"
                              >
                                <div className="pt-6 mt-6 border-t border-white/5">
                                  <div className="flex items-center justify-between mb-6">
                                    <div className="text-[10px] font-black uppercase tracking-widest text-white/40">Configuration Settings</div>
                                    {agent.kind === 'specialist' && (
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          removeAgent(agent.id);
                                        }}
                                        disabled={specialistAgents.length <= 1}
                                        className="inline-flex items-center gap-2 rounded border border-error-red/20 bg-error-red/10 px-3 py-1.5 text-[9px] font-black uppercase tracking-widest text-error-red transition-all hover:bg-error-red/20 disabled:cursor-not-allowed disabled:opacity-40"
                                      >
                                        <Trash2 size={11} />
                                        Decommission Agent
                                      </button>
                                    )}
                                  </div>

                                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-2">
                                    <div className="space-y-2">
                                      <label className="text-[10px] font-black text-white/40 uppercase tracking-widest flex items-center gap-1.5">
                                        <Key size={10} /> {providerType === 'openai-compatible' ? 'Bearer Token (Optional)' : 'API Key (Optional)'}
                                      </label>
                                      <input
                                        type="password"
                                        value={agent.apiKey}
                                        onChange={(e) => updateAgent(agent.id, 'apiKey', e.target.value)}
                                        placeholder="Inherit system key..."
                                        className="w-full bg-black/40 border border-white/10 rounded px-4 py-2 text-xs text-white outline-none focus:border-neon-pink transition-all font-mono"
                                      />
                                    </div>
                                    <div className="space-y-2">
                                      <label className="text-[10px] font-black text-white/40 uppercase tracking-widest">Model Provider</label>
                                      <select
                                        value={providerType}
                                        onChange={(e) => updateAgentProviderType(agent.id, e.target.value as AgentProviderType)}
                                        className="w-full bg-black/40 border border-white/10 rounded px-4 py-2 text-xs text-white outline-none focus:border-neon-pink transition-all"
                                      >
                                        <option value="gemini">Google Gemini (Cloud)</option>
                                        <option value="openai-compatible">OpenAI Compatible (Local)</option>
                                      </select>
                                    </div>
                                    <div className="space-y-2">
                                      <label className="text-[10px] font-black text-white/40 uppercase tracking-widest">{providerUrlLabel}</label>
                                      <input
                                        type="text"
                                        value={agent.providerUrl}
                                        onChange={(e) => updateAgent(agent.id, 'providerUrl', e.target.value)}
                                        className="w-full bg-black/40 border border-white/10 rounded px-4 py-2 text-xs text-white outline-none focus:border-neon-pink transition-all font-mono"
                                      />
                                    </div>
                                    <div className="space-y-2">
                                      <label className="text-[10px] font-black text-white/40 uppercase tracking-widest">AI Agent Type</label>
                                      <select
                                        value={resolvedAgentType}
                                        onChange={(e) => updateAgentType(agent.id, e.target.value as AgentType)}
                                        className="w-full bg-black/40 border border-white/10 rounded px-4 py-2 text-xs text-white outline-none focus:border-neon-pink transition-all"
                                      >
                                        {(Object.entries(AGENT_TYPE_PRESETS) as [AgentType, any][]).map(([agentType, preset]) => (
                                          <option key={`${agent.id}-${agentType}`} value={agentType}>
                                            {preset.label}
                                          </option>
                                        ))}
                                      </select>
                                      <p className="text-[9px] text-white/30 italic">
                                        {isPromptLocked
                                          ? `${agentTypeLabel} uses a locked ready-made prompt. Switch to Custom to edit it.`
                                          : 'Custom keeps the prompt editable for your own specialist design.'}
                                      </p>
                                    </div>
                                    <div className="space-y-2">
                                      <label className="text-[10px] font-black text-white/40 uppercase tracking-widest">Agent Identity Name</label>
                                      <input
                                        type="text"
                                        value={agent.name}
                                        onChange={(e) => updateAgent(agent.id, 'name', e.target.value)}
                                        className="w-full bg-black/40 border border-white/10 rounded px-4 py-2 text-xs text-white outline-none focus:border-neon-pink transition-all"
                                      />
                                    </div>
                                    <div className="space-y-2">
                                      <label className="text-[10px] font-black text-white/40 uppercase tracking-widest">Neon Color</label>
                                      <div className="flex items-center gap-3 rounded border border-white/10 bg-black/30 px-3 py-2">
                                        <input
                                          type="color"
                                          value={normalizeAgentColor(agent.color, DEFAULT_SPECIALIST_COLORS[0])}
                                          onChange={(e) => updateAgent(agent.id, 'color', e.target.value)}
                                          className="h-10 w-12 cursor-pointer rounded border border-white/10 bg-transparent"
                                        />
                                        <div className="flex flex-wrap gap-2">
                                          {DEFAULT_SPECIALIST_COLORS.map((presetColor) => (
                                            <button
                                              key={`${agent.id}-${presetColor}`}
                                              type="button"
                                              onClick={() => updateAgent(agent.id, 'color', presetColor)}
                                              className={`h-6 w-6 rounded-full border transition-all ${normalizeAgentColor(agent.color, presetColor) === presetColor ? 'border-white scale-110' : 'border-white/20 hover:border-white/60'}`}
                                              style={{ backgroundColor: presetColor }}
                                              title={presetColor}
                                            />
                                          ))}
                                        </div>
                                      </div>
                                    </div>
                                    <div className="space-y-2">
                                      <label className="text-[10px] font-black text-white/40 uppercase tracking-widest">Model Verification</label>
                                      <button
                                        onClick={() => handleVerifyAgent(agent.id)}
                                        className="w-full px-4 py-2 rounded bg-white/5 border border-white/10 text-[10px] font-black uppercase tracking-widest text-white/70 hover:bg-white/10 hover:text-neon-cyan transition-all"
                                      >
                                        {agentVerificationState[agent.id]?.status === 'loading' ? 'Verifying...' : verificationButtonLabel}
                                      </button>
                                    </div>
                                    <div className="space-y-2">
                                      <label className="text-[10px] font-black text-white/40 uppercase tracking-widest">{modelLabel}</label>
                                      <input
                                        type="text"
                                        value={agent.model}
                                        onChange={(e) => updateAgent(agent.id, 'model', e.target.value)}
                                        placeholder="Select or type a model name..."
                                        className="w-full bg-black/40 border border-white/10 rounded px-4 py-2 text-xs text-white outline-none focus:border-neon-pink transition-all font-mono"
                                      />

                                      {/* Show suggestions if not verified yet */}
                                      {!agentVerificationState[agent.id] && providerType === 'gemini' && (
                                        <div className="mt-2 flex flex-wrap gap-1.5">
                                          {GEMINI_MODEL_SUGGESTIONS.slice(0, 6).map((m) => (
                                            <button
                                              key={`${agent.id}-sugg-${m}`}
                                              onClick={() => updateAgent(agent.id, 'model', m)}
                                              className="px-2 py-1 rounded bg-white/5 border border-white/5 text-[8px] text-white/40 hover:bg-white/10 transition-all"
                                            >
                                              {m}
                                            </button>
                                          ))}
                                        </div>
                                      )}
                                    </div>
                                    <div className="col-span-full space-y-2">
                                      <label className="text-[10px] font-black text-white/40 uppercase tracking-widest">Short Motto / Description</label>
                                      <input
                                        type="text"
                                        value={agent.description}
                                        onChange={(e) => updateAgent(agent.id, 'description', e.target.value)}
                                        disabled={isPromptLocked}
                                        className={`w-full rounded border px-4 py-2 text-xs outline-none transition-all ${isPromptLocked ? 'cursor-not-allowed border-white/5 bg-black/20 text-white/35' : 'bg-black/40 border-white/10 text-white focus:border-neon-pink'}`}
                                      />
                                    </div>
                                    {agentVerificationState[agent.id] && (
                                      <div className="col-span-full space-y-3">
                                        <div
                                          className={`rounded-lg border px-4 py-3 text-[10px] font-bold tracking-wide ${agentVerificationState[agent.id]?.status === 'success'
                                              ? 'border-success-green/30 bg-success-green/10 text-success-green'
                                              : agentVerificationState[agent.id]?.status === 'error'
                                                ? 'border-error-red/30 bg-error-red/10 text-error-red'
                                                : 'border-neon-cyan/30 bg-neon-cyan/10 text-neon-cyan'
                                            }`}
                                        >
                                          {agentVerificationState[agent.id]?.message}
                                        </div>

                                        {agentVerificationState[agent.id]?.status === 'success' && (agentVerificationState[agent.id]?.models?.length ?? 0) > 0 && (
                                          <div className="rounded-lg border border-white/5 bg-black/40 p-4">
                                            <div className="mb-2 flex items-center justify-between">
                                              <span className="text-[9px] font-black uppercase tracking-widest text-white/40">Verified Available Models</span>
                                              <span className="text-[9px] font-black uppercase tracking-widest text-neon-cyan">{agentVerificationState[agent.id]?.models?.length} Found</span>
                                            </div>
                                            <div className="grid grid-cols-2 gap-2 max-h-32 overflow-y-auto custom-scrollbar pr-2">
                                              {agentVerificationState[agent.id]?.models?.map((modelName) => (
                                                <button
                                                  key={`${agent.id}-verified-${modelName}`}
                                                  onClick={() => updateAgent(agent.id, 'model', modelName)}
                                                  className={`text-left px-3 py-1.5 rounded border border-white/5 text-[9px] font-mono transition-all truncate
                                           ${agent.model === modelName
                                                      ? 'bg-neon-cyan/10 border-neon-cyan/30 text-neon-cyan'
                                                      : 'bg-white/5 text-white/40 hover:bg-white/10 hover:text-white/60'}
                                         `}
                                                  title={modelName}
                                                >
                                                  {modelName}
                                                </button>
                                              ))}
                                            </div>
                                          </div>
                                        )}
                                      </div>
                                    )}

                                    <div className="col-span-full space-y-2">
                                      <label className="text-[10px] font-black text-neon-cyan uppercase tracking-widest flex items-center gap-1.5">
                                        <Database size={10} /> Multi-Knowledge Base Integration
                                      </label>
                                      <div className="grid grid-cols-2 gap-2 p-3 bg-black/40 border border-white/10 rounded">
                                        {localConfig.knowledgeBases.map(kb => (
                                          <button
                                            key={kb.id}
                                            onClick={() => toggleAgentKB(agent.id, kb.id)}
                                            className={`flex items-center justify-between p-2 rounded border transition-all text-[10px] uppercase font-bold tracking-wider
                                    ${(agent.kbIds || []).includes(kb.id)
                                                ? 'border-neon-cyan/50 bg-neon-cyan/10 text-neon-cyan'
                                                : 'border-white/5 bg-white/[0.02] text-white/40 hover:border-white/20'}
                                  `}
                                          >
                                            <span>{kb.name}</span>
                                            {(agent.kbIds || []).includes(kb.id) && <div className="w-1.5 h-1.5 rounded-full bg-neon-cyan animate-pulse" />}
                                          </button>
                                        ))}
                                      </div>
                                      <p className="text-[9px] text-white/30 italic">
                                        This agent will simultaneously query all selected knowledge bases to retrieve multi-domain context.
                                      </p>
                                    </div>

                                    <div className="col-span-full space-y-2">
                                      <label className="text-[10px] font-black text-white/40 uppercase tracking-widest">Cognitive Role / System Prompt</label>
                                      <textarea
                                        value={agent.role}
                                        onChange={(e) => updateAgent(agent.id, 'role', e.target.value)}
                                        disabled={isPromptLocked}
                                        rows={4}
                                        className={`w-full rounded border px-4 py-3 text-[11px] outline-none transition-all leading-relaxed custom-scrollbar ${isPromptLocked ? 'cursor-not-allowed border-white/5 bg-black/20 text-white/35' : 'bg-black/40 border-white/10 text-white/80 focus:border-neon-pink'}`}
                                      />
                                      {isPromptLocked && (
                                        <p className="text-[9px] text-neon-cyan/80 italic">
                                          {agentTypeLabel} keeps this prompt locked so the ready-made specialist stays consistent.
                                        </p>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </div>
                      );
                    })}
                  </div>
                )}

                {activeTab === 'kb' && (
                  <div className="space-y-8">
                    <div className="flex items-center justify-between">
                      <h3 className="text-[10px] font-black uppercase tracking-[0.3em] text-white/40">Registered Data Vectors</h3>
                      <button
                        onClick={addKB}
                        className="flex items-center space-x-2 px-4 py-1.5 bg-white/5 border border-white/10 rounded-full text-[9px] font-black uppercase tracking-widest text-white hover:bg-white/10 transition-all"
                      >
                        <Plus size={12} />
                        <span>Register New KB</span>
                      </button>
                    </div>

                    <div className="grid grid-cols-1 gap-4">
                      {localConfig.knowledgeBases.map((kb) => (
                        (() => {
                          const modelOptions = getEmbeddingModelOptions(kb.embedderProvider);
                          const resolvedDimension = kb.embeddingModelDimension
                            ?? getEmbeddingModelDimension(kb.embedderProvider, kb.embeddingModel);
                          const documentState = kbDocumentState[kb.id];
                          const isExpanded = expandedKnowledgeBaseIds.includes(kb.id);

                          return (
                            <div
                              key={kb.id}
                              className={`p-6 rounded-xl border transition-all duration-500
                          ${localConfig.selectedKBIds.includes(kb.id) ? 'border-neon-cyan bg-neon-cyan/5' : 'border-white/5 bg-white/[0.02]'}
                        `}
                            >
                              <div
                                onClick={() => toggleKnowledgeBaseExpanded(kb.id)}
                                className="cursor-pointer rounded-xl border border-white/5 bg-black/20 p-4 transition-all hover:border-white/10 hover:bg-white/[0.03]"
                              >
                                <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
                                  <div className="flex min-w-0 items-start gap-3">
                                    <button
                                      type="button"
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        toggleKnowledgeBaseExpanded(kb.id);
                                      }}
                                      className={`mt-0.5 rounded-full border p-1.5 transition-all ${isExpanded
                                          ? 'border-neon-cyan/40 bg-neon-cyan/10 text-neon-cyan'
                                          : 'border-white/10 bg-white/5 text-white/45'
                                        }`}
                                    >
                                      <ChevronDown
                                        size={14}
                                        className={`transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                                      />
                                    </button>
                                    <div className="min-w-0 flex-1 space-y-3">
                                      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                                        <div
                                          className="flex items-center gap-3"
                                          onClick={(event) => event.stopPropagation()}
                                        >
                                          <input
                                            type="checkbox"
                                            checked={localConfig.selectedKBIds.includes(kb.id)}
                                            onChange={() => toggleGlobalKB(kb.id)}
                                            className="w-3 h-3 accent-neon-cyan"
                                          />
                                          <input
                                            type="text"
                                            value={kb.name}
                                            onChange={(e) => updateKB(kb.id, 'name', e.target.value)}
                                            className="w-full max-w-md bg-transparent border-none text-xs font-black text-white uppercase tracking-widest outline-none focus:ring-0"
                                          />
                                        </div>
                                        <span className="text-[9px] font-black uppercase tracking-[0.28em] text-white/25">
                                          {isExpanded ? 'Hide Database Settings' : 'Show Database Settings'}
                                        </span>
                                      </div>
                                      <div className="flex flex-wrap gap-2 text-[9px] font-black uppercase tracking-widest text-white/45">
                                        <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5">
                                          Collection: {kb.collectionName || 'Not set'}
                                        </span>
                                        <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5">
                                          Embedder: {kb.embedderProvider}
                                        </span>
                                        <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5">
                                          Graph: {kb.graphName || 'Not set'}
                                        </span>
                                      </div>
                                    </div>
                                  </div>

                                  <div
                                    className="flex flex-wrap items-center gap-3"
                                    onClick={(event) => event.stopPropagation()}
                                  >
                                    <button
                                      onClick={() => handleTestConnection(kb)}
                                      className="px-3 py-1.5 rounded border border-white/10 bg-white/5 text-[9px] font-black uppercase tracking-widest text-white/60 hover:bg-white/10 hover:text-neon-cyan transition-all"
                                    >
                                      {kbConnectionState[kb.id]?.status === 'loading' ? 'Testing...' : 'Test Connection'}
                                    </button>
                                    {kbConnectionState[kb.id]?.status === 'success' && (
                                      <>
                                        <input
                                          id={`kb-upload-${kb.id}`}
                                          type="file"
                                          multiple
                                          className="hidden"
                                          onChange={(event) => {
                                            void handleKnowledgeBaseUpload(kb, event.target.files);
                                            event.currentTarget.value = '';
                                          }}
                                        />
                                        <label
                                          htmlFor={`kb-upload-${kb.id}`}
                                          className="px-3 py-1.5 rounded border border-neon-cyan/30 bg-neon-cyan/10 text-[9px] font-black uppercase tracking-widest text-neon-cyan hover:bg-neon-cyan/20 transition-all cursor-pointer"
                                        >
                                          {kbIngestionState[kb.id]?.status === 'loading' ? 'Embedding...' : 'Upload Files'}
                                        </label>
                                        <button
                                          onClick={() => handleOpenKnowledgeBaseDocuments(kb)}
                                          className="px-3 py-1.5 rounded border border-white/10 bg-white/5 text-[9px] font-black uppercase tracking-widest text-white/70 hover:bg-white/10 hover:text-neon-cyan transition-all"
                                        >
                                          {kbDocumentState[kb.id]?.status === 'loading' ? 'Loading...' : 'View Files'}
                                        </button>
                                      </>
                                    )}
                                    <button
                                      onClick={() => removeKB(kb.id)}
                                      className="text-white/20 hover:text-neon-pink transition-colors"
                                    >
                                      <Trash2 size={14} />
                                    </button>
                                  </div>
                                </div>
                              </div>

                              <AnimatePresence initial={false}>
                                {isExpanded && (
                                  <motion.div
                                    initial={{ height: 0, opacity: 0 }}
                                    animate={{ height: 'auto', opacity: 1 }}
                                    exit={{ height: 0, opacity: 0 }}
                                    transition={{ duration: 0.2, ease: 'easeOut' }}
                                    className="overflow-hidden"
                                  >
                                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8 mt-6">
                                      <div className="space-y-2">
                                        <label className="text-[9px] font-black text-white/30 uppercase tracking-widest flex items-center gap-1.5">
                                          <Cpu size={10} /> Vector DB URL (Qdrant)
                                        </label>
                                        <input
                                          type="text"
                                          value={kb.url || ''}
                                          onChange={(e) => updateKB(kb.id, 'url', e.target.value)}
                                          placeholder="https://your-qdrant-cluster.cloud"
                                          className="w-full bg-black/40 border border-white/10 rounded px-3 py-2 text-[10px] text-white outline-none focus:border-neon-cyan transition-all"
                                        />
                                      </div>
                                      <div className="space-y-2">
                                        <label className="text-[9px] font-black text-white/30 uppercase tracking-widest flex items-center gap-1.5">
                                          <Key size={10} /> Vector DB API Key
                                        </label>
                                        <input
                                          type="password"
                                          value={kb.apiKey || ''}
                                          onChange={(e) => updateKB(kb.id, 'apiKey', e.target.value)}
                                          placeholder="Enter cluster API key..."
                                          className="w-full bg-black/40 border border-white/10 rounded px-3 py-2 text-[10px] text-white outline-none focus:border-neon-cyan transition-all"
                                        />
                                      </div>
                                      <div className="space-y-2">
                                        <label className="text-[9px] font-black text-white/30 uppercase tracking-widest flex items-center gap-1.5">
                                          <Database size={10} /> Collection Name
                                        </label>
                                        <input
                                          type="text"
                                          value={kb.collectionName || ''}
                                          onChange={(e) => updateKB(kb.id, 'collectionName', e.target.value)}
                                          placeholder="e.g. enterprise_docs"
                                          className="w-full bg-black/40 border border-white/10 rounded px-3 py-2 text-[10px] text-white outline-none focus:border-neon-cyan transition-all"
                                        />
                                      </div>
                                    </div>

                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
                                      <div className="space-y-2">
                                        <label className="text-[9px] font-black text-white/30 uppercase tracking-widest flex items-center gap-1.5">
                                          <Database size={10} /> FalkorDB URL
                                        </label>
                                        <input
                                          type="text"
                                          value={kb.graphUrl || ''}
                                          onChange={(e) => updateKB(kb.id, 'graphUrl', e.target.value)}
                                          placeholder="redis://username:password@host:6379"
                                          className="w-full bg-black/40 border border-white/10 rounded px-3 py-2 text-[10px] text-white outline-none focus:border-neon-cyan transition-all"
                                        />
                                      </div>
                                      <div className="space-y-2">
                                        <label className="text-[9px] font-black text-white/30 uppercase tracking-widest flex items-center gap-1.5">
                                          <Cpu size={10} /> FalkorDB Graph Name
                                        </label>
                                        <input
                                          type="text"
                                          value={kb.graphName || ''}
                                          onChange={(e) => updateKB(kb.id, 'graphName', e.target.value)}
                                          placeholder="catog_enterprise_graph"
                                          className="w-full bg-black/40 border border-white/10 rounded px-3 py-2 text-[10px] text-white outline-none focus:border-neon-cyan transition-all"
                                        />
                                      </div>
                                    </div>

                                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
                                      <div className="space-y-2">
                                        <label className="text-[9px] font-black text-white/30 uppercase tracking-widest">Embedder Provider</label>
                                        <div className="w-full bg-black/40 border border-neon-cyan/20 rounded px-2 py-1.5 text-[10px] text-neon-cyan font-bold uppercase tracking-widest">
                                          OpenAI Compatible (Local)
                                        </div>
                                      </div>
                                      <div className="space-y-2">
                                        <label className="text-[9px] font-black text-white/30 uppercase tracking-widest">Embedding API Key</label>
                                        <input
                                          type="password"
                                          value={kb.embeddingApiKey || ''}
                                          onChange={(e) => updateKB(kb.id, 'embeddingApiKey', e.target.value)}
                                          placeholder="Optional Bearer Token"
                                          className="w-full bg-black/40 border border-white/10 rounded px-3 py-2 text-[10px] text-white outline-none focus:border-neon-cyan transition-all"
                                        />
                                      </div>
                                      <div className="space-y-2">
                                        <label className="text-[9px] font-black text-white/30 uppercase tracking-widest">Embedding Base URL</label>
                                        <input
                                          type="text"
                                          value={kb.embeddingBaseUrl || ''}
                                          onChange={(e) => updateKB(kb.id, 'embeddingBaseUrl', e.target.value)}
                                          placeholder="http://127.0.0.1:8001/v1"
                                          className="w-full bg-black/40 border border-white/10 rounded px-3 py-2 text-[10px] text-white outline-none focus:border-neon-cyan transition-all"
                                        />
                                      </div>
                                    </div>

                                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8 mt-6">
                                      <div className="space-y-2">
                                        <label className="text-[9px] font-black text-white/30 uppercase tracking-widest">Graph Extraction Provider</label>
                                        <select
                                          value={kb.graphExtractionProvider || 'heuristic'}
                                          onChange={(e) => updateKB(kb.id, 'graphExtractionProvider', e.target.value)}
                                          className="w-full bg-black/40 border border-white/10 rounded px-2 py-1.5 text-[10px] text-white outline-none"
                                        >
                                          <option value="heuristic">Heuristic (Local Patterns)</option>
                                          <option value="gemini">Google Gemini (Cloud LLM)</option>
                                          <option value="openai-compatible">OpenAI Compatible (Local LLM)</option>
                                        </select>
                                      </div>
                                      <div className="space-y-2">
                                        <label className="text-[9px] font-black text-white/30 uppercase tracking-widest">Graph Extraction API Key</label>
                                        <input
                                          type="password"
                                          value={kb.graphExtractionApiKey || ''}
                                          onChange={(e) => updateKB(kb.id, 'graphExtractionApiKey', e.target.value)}
                                          placeholder="Extraction API key..."
                                          className="w-full bg-black/40 border border-white/10 rounded px-3 py-2 text-[10px] text-white outline-none focus:border-neon-cyan transition-all"
                                        />
                                      </div>
                                      <div className="space-y-2">
                                        <label className="text-[9px] font-black text-white/30 uppercase tracking-widest">Graph Extraction Base URL</label>
                                        <input
                                          type="text"
                                          value={kb.graphExtractionBaseUrl || ''}
                                          onChange={(e) => updateKB(kb.id, 'graphExtractionBaseUrl', e.target.value)}
                                          placeholder="http://127.0.0.1:8080/v1"
                                          className="w-full bg-black/40 border border-white/10 rounded px-3 py-2 text-[10px] text-white outline-none focus:border-neon-cyan transition-all"
                                        />
                                      </div>
                                      <div className="space-y-2 col-span-full">
                                        <label className="text-[9px] font-black text-white/30 uppercase tracking-widest">Graph Extraction Model</label>
                                        <input
                                          type="text"
                                          value={kb.graphExtractionModel || ''}
                                          onChange={(e) => updateKB(kb.id, 'graphExtractionModel', e.target.value)}
                                          placeholder="e.g. nomic-embed-text-v1.5 or your extraction LLM"
                                          className="w-full bg-black/40 border border-white/10 rounded px-3 py-2 text-[10px] text-white outline-none focus:border-neon-cyan transition-all font-mono"
                                        />
                                      </div>
                                    </div>

                                    <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
                                      <div className="space-y-2">
                                        <label className="text-[9px] font-black text-white/30 uppercase tracking-widest">RAG Strategy</label>
                                        <select
                                          value={kb.ragEngine}
                                          onChange={(e) => updateKB(kb.id, 'ragEngine', e.target.value)}
                                          className="w-full bg-black/40 border border-white/10 rounded px-2 py-1.5 text-[10px] text-white outline-none"
                                        >
                                          <option value="standard">Standard BFS</option>
                                          <option value="enhanced">Graph-Augmented</option>
                                          <option value="neural">Neural Contextual</option>
                                          <option value="hybrid">Hybrid Search</option>
                                        </select>
                                      </div>
                                      <div className="space-y-2">
                                        <label className="text-[9px] font-black text-white/30 uppercase tracking-widest">Embedding Model</label>
                                        <input
                                          list={`embedding-model-options-${kb.id}`}
                                          value={kb.embeddingModel}
                                          onChange={(e) => updateEmbeddingModel(kb.id, kb.embedderProvider, e.target.value)}
                                          placeholder="Type any embedding model name or pick a preset"
                                          className="w-full bg-black/40 border border-white/10 rounded px-3 py-2 text-[10px] text-white outline-none focus:border-neon-cyan transition-all"
                                        />
                                        <datalist id={`embedding-model-options-${kb.id}`}>
                                          {modelOptions.map((option) => (
                                            <option key={option.value} value={option.value} />
                                          ))}
                                        </datalist>
                                        <p className="text-[8px] text-white/25">
                                          Presets: {modelOptions.map((option) => option.label).join(', ')}
                                        </p>
                                      </div>
                                      <div className="space-y-2">
                                        <label className="text-[9px] font-black text-white/30 uppercase tracking-widest">Model Dimension</label>
                                        <input
                                          type="number"
                                          value={resolvedDimension || ''}
                                          onChange={(e) => updateKB(kb.id, 'embeddingModelDimension', parseInt(e.target.value))}
                                          className="w-full bg-black/40 border border-white/10 rounded px-2 py-1.5 text-[10px] text-white outline-none font-mono"
                                        />
                                      </div>
                                      <div className="space-y-2">
                                        <label className="text-[9px] font-black text-white/30 uppercase tracking-widest">Chunk Size</label>
                                        <input
                                          type="number"
                                          value={kb.chunkSize}
                                          onChange={(e) => updateKB(kb.id, 'chunkSize', parseInt(e.target.value))}
                                          className="w-full bg-black/40 border border-white/10 rounded px-2 py-1.5 text-[10px] text-white outline-none font-mono"
                                        />
                                      </div>
                                      <div className="space-y-2">
                                        <label className="text-[9px] font-black text-white/30 uppercase tracking-widest">Overlap %</label>
                                        <input
                                          type="number"
                                          value={kb.overlap}
                                          onChange={(e) => updateKB(kb.id, 'overlap', parseInt(e.target.value))}
                                          className="w-full bg-black/40 border border-white/10 rounded px-2 py-1.5 text-[10px] text-white outline-none font-mono"
                                        />
                                      </div>
                                    </div>

                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-6">
                                      <div className="space-y-2">
                                        <label className="text-[9px] font-black text-white/30 uppercase tracking-widest">Search Min Score</label>
                                        <input
                                          type="number"
                                          min="0"
                                          max="1"
                                          step="0.01"
                                          value={kb.searchMinScore ?? ''}
                                          onChange={(e) => updateKB(kb.id, 'searchMinScore', parseFloat(e.target.value))}
                                          className="w-full bg-black/40 border border-white/10 rounded px-2 py-1.5 text-[10px] text-white outline-none font-mono"
                                        />
                                      </div>
                                      <div className="space-y-2">
                                        <label className="text-[9px] font-black text-white/30 uppercase tracking-widest">Search Max Results</label>
                                        <input
                                          type="number"
                                          min="1"
                                          value={kb.searchMaxResults ?? 5}
                                          onChange={(e) => updateKB(kb.id, 'searchMaxResults', parseInt(e.target.value))}
                                          className="w-full bg-black/40 border border-white/10 rounded px-2 py-1.5 text-[10px] text-white outline-none font-mono"
                                        />
                                      </div>
                                    </div>
                                    {kbConnectionState[kb.id] && (
                                      <div
                                        className={`mt-6 rounded-lg border px-4 py-3 text-[10px] font-bold tracking-wide ${kbConnectionState[kb.id].status === 'success'
                                            ? 'border-success-green/30 bg-success-green/10 text-success-green'
                                            : kbConnectionState[kb.id].status === 'error'
                                              ? 'border-error-red/30 bg-error-red/10 text-error-red'
                                              : 'border-neon-cyan/30 bg-neon-cyan/10 text-neon-cyan'
                                          }`}
                                      >
                                        {kbConnectionState[kb.id].message}
                                      </div>
                                    )}
                                    {kbIngestionState[kb.id] && (
                                      <div
                                        className={`mt-3 rounded-lg border px-4 py-3 text-[10px] font-bold tracking-wide ${kbDocumentState[kb.id]?.status === 'error'
                                            ? 'border-error-red/30 bg-error-red/10 text-error-red'
                                            : kbIngestionState[kb.id].status === 'success'
                                              ? 'border-success-green/30 bg-success-green/10 text-success-green'
                                              : kbIngestionState[kb.id].status === 'error'
                                                ? 'border-error-red/30 bg-error-red/10 text-error-red'
                                                : 'border-neon-cyan/30 bg-neon-cyan/10 text-neon-cyan'
                                          }`}
                                      >
                                        <div className="flex items-center justify-between gap-4">
                                          <span>{kbIngestionState[kb.id].message}</span>
                                          <span className="shrink-0 text-[9px] font-black uppercase tracking-widest">
                                            {Math.round(kbIngestionState[kb.id].progress)}%
                                          </span>
                                        </div>
                                        <div className="mt-3 h-2 overflow-hidden rounded-full bg-black/30">
                                          <div
                                            className={`h-full rounded-full transition-all duration-500 ${kbIngestionState[kb.id].status === 'success'
                                                ? 'bg-success-green'
                                                : kbIngestionState[kb.id].status === 'error'
                                                  ? 'bg-error-red'
                                                  : 'bg-neon-cyan animate-pulse'
                                              }`}
                                            style={{ width: `${Math.max(kbIngestionState[kb.id].progress, 4)}%` }}
                                          />
                                        </div>
                                        <div className="mt-2 flex items-center justify-between text-[9px] uppercase tracking-widest text-white/40">
                                          <span>{formatIngestionStage(kbIngestionState[kb.id].stage)}</span>
                                          <span>
                                            {kbIngestionState[kb.id].processedFiles}/{kbIngestionState[kb.id].fileCount} file(s)
                                          </span>
                                        </div>
                                        {kbIngestionState[kb.id].files.length > 0 && (
                                          <div className="mt-3 space-y-2 rounded-lg border border-white/5 bg-black/20 p-3">
                                            {kbIngestionState[kb.id].files.map((file) => (
                                              <div key={`${kb.id}-${file.name}`} className="space-y-1.5">
                                                <div className="flex items-center justify-between gap-3 text-[9px] uppercase tracking-widest">
                                                  <span className="truncate text-white/70">{file.name}</span>
                                                  <span className={`shrink-0 font-black ${file.status === 'complete'
                                                      ? 'text-success-green'
                                                      : file.status === 'error'
                                                        ? 'text-error-red'
                                                        : file.status === 'indexing'
                                                          ? 'text-neon-yellow'
                                                          : file.status === 'embedding'
                                                            ? 'text-neon-cyan'
                                                            : 'text-white/40'
                                                    }`}>
                                                    {formatQueueStatus(file.status)}
                                                  </span>
                                                </div>
                                                <div className="h-1.5 overflow-hidden rounded-full bg-white/5">
                                                  <div
                                                    className={`h-full rounded-full transition-all duration-500 ${file.status === 'complete'
                                                        ? 'bg-success-green'
                                                        : file.status === 'error'
                                                          ? 'bg-error-red'
                                                          : file.status === 'indexing'
                                                            ? 'bg-neon-yellow'
                                                            : file.status === 'embedding'
                                                              ? 'bg-neon-cyan'
                                                              : 'bg-white/20'
                                                      }`}
                                                    style={{ width: `${Math.max(file.progress, 4)}%` }}
                                                  />
                                                </div>
                                              </div>
                                            ))}
                                          </div>
                                        )}
                                      </div>
                                    )}
                                    {documentState && (
                                      <div
                                        className={`mt-3 rounded-lg border px-4 py-3 text-[10px] font-bold tracking-wide ${documentState.status === 'success'
                                            ? 'border-neon-cyan/25 bg-neon-cyan/10 text-neon-cyan'
                                            : documentState.status === 'error'
                                              ? 'border-error-red/30 bg-error-red/10 text-error-red'
                                              : 'border-neon-cyan/30 bg-neon-cyan/10 text-neon-cyan'
                                          }`}
                                      >
                                        {documentState.message}
                                      </div>
                                    )}
                                  </motion.div>
                                )}
                              </AnimatePresence>
                            </div>
                          );
                        })()
                      ))}
                    </div>
                  </div>
                )}

                {activeTab === 'logs' && (
                  <div className="flex flex-col h-full space-y-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-[10px] font-black uppercase tracking-[0.3em] text-white/40">Native Event Stream</h3>
                        <p className="mt-1 text-[10px] text-white/30 uppercase tracking-widest italic">Tracing background agent processes and system state.</p>
                      </div>
                      <button
                        onClick={async () => {
                          setIsLoadingLogs(true);
                          const logs = await readSystemLog();
                          setSystemLogs(logs);
                          setIsLoadingLogs(false);
                        }}
                        disabled={isLoadingLogs}
                        className="flex items-center space-x-2 px-3 py-1.5 rounded border border-white/10 bg-white/5 text-[9px] font-black uppercase tracking-widest text-white hover:bg-white/10 hover:text-neon-yellow transition-all"
                      >
                        <RefreshCw size={12} className={isLoadingLogs ? 'animate-spin' : ''} />
                        <span>Refresh Logs</span>
                      </button>
                    </div>

                    <div className="flex-1 bg-black/40 border border-white/5 rounded-xl overflow-hidden flex flex-col">
                      <div className="p-2 bg-white/5 border-b border-white/5 flex items-center justify-between">
                        <span className="text-[9px] font-black uppercase tracking-widest text-white/20 px-2">systemlogs.txt</span>
                        <div className="flex items-center space-x-2">
                          <div className="w-2 h-2 rounded-full bg-error-red/40" />
                          <div className="w-2 h-2 rounded-full bg-neon-yellow/40" />
                          <div className="w-2 h-2 rounded-full bg-success-green/40" />
                        </div>
                      </div>
                      <div className="flex-1 overflow-auto p-4 custom-scrollbar bg-black/20 font-mono text-[10px] leading-relaxed">
                        {isLoadingLogs ? (
                          <div className="flex items-center justify-center h-full text-white/20 animate-pulse uppercase tracking-[0.2em]">
                            Accessing secure log stream...
                          </div>
                        ) : systemLogs ? (
                          <div className="space-y-1">
                            {systemLogs.split('\n').filter(l => l.trim()).map((line, i) => {
                              try {
                                const log = JSON.parse(line);
                                const levelColor = log.level === 'error' ? 'text-error-red' : log.level === 'warn' ? 'text-neon-yellow' : 'text-neon-cyan';
                                return (
                                  <div key={i} className="flex gap-3 hover:bg-white/5 p-1 rounded transition-colors group">
                                    <span className="text-white/20 whitespace-nowrap">[{new Date(log.at).toLocaleTimeString()}]</span>
                                    <span className={`${levelColor} font-black uppercase min-w-[50px]`}>{log.level}</span>
                                    <span className="text-white/60 font-bold">[{log.scope}]</span>
                                    <span className="text-white/80">{log.message || log.event}</span>
                                    {log.details && (
                                      <span className="text-white/20 group-hover:text-white/40 transition-colors">
                                        {JSON.stringify(log.details).slice(0, 50)}...
                                      </span>
                                    )}
                                  </div>
                                );
                              } catch {
                                return <div key={i} className="text-white/30 italic">{line}</div>;
                              }
                            })}
                          </div>
                        ) : (
                          <div className="flex items-center justify-center h-full text-white/10 uppercase tracking-[0.2em]">
                            Log stream is currently empty.
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Footer */}
            <div className="p-6 border-t border-white/10 bg-[#161618] flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <div className="w-1.5 h-1.5 rounded-full bg-success-green animate-pulse" />
                <span className="text-[10px] font-black text-white/20 uppercase tracking-[0.2em]">Config Snapshot Validated</span>
              </div>
              <div className="flex space-x-4">
                <button
                  onClick={onClose}
                  className="text-[11px] font-black uppercase tracking-widest text-white/40 hover:text-white transition-all px-6 py-2"
                >
                  Discard
                </button>
                <button
                  onClick={handleSave}
                  className="bg-white text-black text-[11px] font-black uppercase tracking-widest px-10 py-2.5 rounded hover:bg-neon-pink transition-all shadow-[0_0_15px_rgba(255,255,255,0.1)]"
                >
                  Apply Global State
                </button>
              </div>
            </div>
          </motion.div>
        </div>
        <KnowledgeBaseFilesModal
          isOpen={Boolean(activeKnowledgeBaseDocument)}
          knowledgeBase={activeKnowledgeBaseDocument}
          documentState={activeKnowledgeBaseDocument ? kbDocumentState[activeKnowledgeBaseDocument.id] : undefined}
          searchTerm={activeKnowledgeBaseDocument ? kbDocumentSearch[activeKnowledgeBaseDocument.id] || '' : ''}
          onClose={() => setActiveKnowledgeBaseDocumentId(null)}
          onSearchChange={(value) => {
            if (activeKnowledgeBaseDocument) {
              setKnowledgeBaseDocumentSearch(activeKnowledgeBaseDocument.id, value);
            }
          }}
          onRefresh={() => {
            if (activeKnowledgeBaseDocument) {
              void handleViewKnowledgeBaseDocuments(activeKnowledgeBaseDocument);
            }
          }}
          onToggleFileSelection={(fileName) => {
            if (activeKnowledgeBaseDocument) {
              toggleKnowledgeBaseDocumentSelection(activeKnowledgeBaseDocument.id, fileName);
            }
          }}
          onToggleVisibleSelection={(fileNames, shouldSelect) => {
            if (activeKnowledgeBaseDocument) {
              toggleKnowledgeBaseDocumentSelectionBatch(activeKnowledgeBaseDocument.id, fileNames, shouldSelect);
            }
          }}
          onClearSelection={() => {
            if (!activeKnowledgeBaseDocument) {
              return;
            }

            setKbDocumentState((currentState) => ({
              ...currentState,
              [activeKnowledgeBaseDocument.id]: {
                ...(currentState[activeKnowledgeBaseDocument.id] || {
                  status: 'success',
                  message: '',
                  documents: [],
                  selectedFiles: [],
                }),
                selectedFiles: [],
              },
            }));
          }}
          onDeleteSelected={() => {
            if (activeKnowledgeBaseDocument) {
              void handleDeleteKnowledgeBaseDocuments(activeKnowledgeBaseDocument);
            }
          }}
        />
      </>
    </AnimatePresence>
  );
}
