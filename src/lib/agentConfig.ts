import { AgentConfig, AgentType, AppConfig } from '../types';
import { DEFAULT_LOCAL_AGENT_MODEL, DEFAULT_LOCAL_AGENT_PROVIDER_URL } from '../services/agentProviders';

export const CORE_AGENT_ID = 'core';
export const DEFAULT_CORE_AGENT_COLOR = '#FF8A00';
export const DEFAULT_SPECIALIST_COLORS = ['#FF2D95', '#00D2FF', '#CCFF00', '#00FF88', '#A020F0', '#FF5F1F'];

const HEX_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}){1,2}$/;

export const AGENT_TYPE_PRESETS: Record<AgentType, {
  label: string;
  description: string;
  role: string;
  promptLocked: boolean;
}> = {
  custom: {
    label: 'Custom',
    description: 'Custom specialist agent.',
    role: 'You are a specialist AI agent. Focus on your configured domain, review the document carefully, and return precise, actionable findings, corrections, and obligations.',
    promptLocked: false,
  },
  auditor: {
    label: 'Auditor',
    description: 'Audits document structure, controls, evidence, and completeness.',
    role: 'You are an Auditor AI agent. Focus on audit readiness, document completeness, internal control gaps, missing evidence, approval flows, inconsistencies, traceability, and structural integrity. Flag unsupported claims, missing required sections, weak evidence trails, and formal document architecture issues.',
    promptLocked: true,
  },
  legal: {
    label: 'Legal',
    description: 'Reviews legal meaning, citations, jurisdiction, and case-linked risk.',
    role: 'You are a Legal AI agent. Focus on legal analysis, legal citations, statutory references, jurisdictional issues, contractual enforceability, precedent-sensitive wording, regulatory exposure, and legal risk. Highlight legal ambiguities, missing legal support, citation-sensitive gaps, and wording that could create legal exposure.',
    promptLocked: true,
  },
};

export const resolveAgentType = (agentType: string | undefined | null): AgentType => (
  agentType === 'auditor' || agentType === 'legal' || agentType === 'custom'
    ? agentType
    : 'custom'
);

export const normalizeAgentColor = (value: string | undefined, fallback: string) => (
  value && HEX_COLOR_PATTERN.test(value.trim()) ? value.trim().toUpperCase() : fallback
);

export const getAgentTextColor = (color: string) => {
  const normalized = normalizeAgentColor(color, '#FFFFFF').slice(1);
  const expanded = normalized.length === 3
    ? normalized.split('').map((char) => `${char}${char}`).join('')
    : normalized;

  const red = parseInt(expanded.slice(0, 2), 16);
  const green = parseInt(expanded.slice(2, 4), 16);
  const blue = parseInt(expanded.slice(4, 6), 16);
  const brightness = (red * 299 + green * 587 + blue * 114) / 1000;

  return brightness > 165 ? '#0D0D0F' : '#FFFFFF';
};

export const createSpecialistAgentId = () => `specialist-${Math.random().toString(36).slice(2, 8)}`;

export const isLockedAgentType = (agentType: string | undefined | null) => AGENT_TYPE_PRESETS[resolveAgentType(agentType)].promptLocked;

export const applyAgentTypePreset = (agent: AgentConfig, agentType: AgentType): AgentConfig => {
  const resolvedAgentType = resolveAgentType(agentType);
  const preset = AGENT_TYPE_PRESETS[resolvedAgentType];
  return {
    ...agent,
    agentType: resolvedAgentType,
    description: resolvedAgentType === 'custom' ? (agent.description || preset.description) : preset.description,
    role: resolvedAgentType === 'custom' ? (agent.role || preset.role) : preset.role,
  };
};

export const createSpecialistAgentConfig = (
  specialistIndex: number,
  overrides: Partial<AgentConfig> = {},
): AgentConfig => {
  const fallbackColor = DEFAULT_SPECIALIST_COLORS[(Math.max(specialistIndex, 1) - 1) % DEFAULT_SPECIALIST_COLORS.length];
  const agentType = resolveAgentType(overrides.agentType);
  const preset = AGENT_TYPE_PRESETS[agentType];

  return {
    id: overrides.id || createSpecialistAgentId(),
    kind: 'specialist',
    agentType,
    providerType: overrides.providerType || 'openai-compatible',
    order: overrides.order ?? specialistIndex,
    name: overrides.name || `SPECIALIST ${specialistIndex}`,
    color: normalizeAgentColor(overrides.color, fallbackColor),
    description: agentType === 'custom' ? (overrides.description || preset.description) : preset.description,
    role: agentType === 'custom' ? (overrides.role || preset.role) : preset.role,
    apiKey: overrides.apiKey || '',
    providerUrl: overrides.providerUrl || DEFAULT_LOCAL_AGENT_PROVIDER_URL,
    model: overrides.model || DEFAULT_LOCAL_AGENT_MODEL,
    kbIds: overrides.kbIds || [],
  };
};

export const getOrderedAgents = (config: AppConfig): AgentConfig[] => (
  Object.values(config.agents).sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === 'core' ? -1 : 1;
    }
    if (left.order !== right.order) {
      return left.order - right.order;
    }
    return left.name.localeCompare(right.name);
  })
);

export const getCoreAgent = (config: AppConfig): AgentConfig => {
  const coreAgent = config.agents[CORE_AGENT_ID]
    || getOrderedAgents(config).find((agent) => agent.kind === 'core');

  if (!coreAgent) {
    throw new Error('A core agent configuration is required.');
  }

  return coreAgent;
};

export const getSpecialistAgents = (config: AppConfig): AgentConfig[] => (
  getOrderedAgents(config).filter((agent) => agent.kind === 'specialist')
);

export const getPipelineFinalStep = (config: AppConfig) => getSpecialistAgents(config).length + 3;
