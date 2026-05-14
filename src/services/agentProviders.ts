import { GoogleGenAI } from '@google/genai';
import { AgentConfig, AgentProviderType } from '../types';
import { getGeminiApiKey } from '../lib/runtime';

export const DEFAULT_LOCAL_AGENT_PROVIDER_URL = 'http://127.0.0.1:8080/v1'; // Default to Lobster Trap Proxy
export const DEFAULT_LOCAL_AGENT_MODEL = 'gemini-1.5-pro'; // Optimized for Legal Context

type OpenAiModelsResponse = {
  data?: Array<{
    id?: string;
  }>;
  error?: {
    message?: string;
  };
};

const FACTUAL_TEMPERATURE = 0;
const GEMINI_PROVIDER_MARKERS = [
  'generativelanguage.googleapis.com',
  'ai.google.dev',
];

export const normalizeProviderUrl = (providerUrl: string) => providerUrl.replace(/\/+$/, '');

export const isGeminiProviderUrl = (providerUrl?: string) => {
  const normalized = normalizeProviderUrl(providerUrl || '').toLowerCase();
  return GEMINI_PROVIDER_MARKERS.some((marker) => normalized.includes(marker));
};

export const resolveAgentProviderType = (agentConfig: Pick<AgentConfig, 'providerType' | 'providerUrl'>): AgentProviderType => (
  agentConfig.providerType === 'gemini' || agentConfig.providerType === 'openai-compatible'
    ? agentConfig.providerType
    : (isGeminiProviderUrl(agentConfig.providerUrl) ? 'gemini' : 'openai-compatible')
);

const extractAssistantText = (
  content: string | Array<{ text?: string }> | undefined,
) => {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content.map((part) => part.text || '').join('\n').trim();
  }

  return '';
};

const readOpenAiCompatibleContent = async ({
  baseUrl,
  apiKey,
  model,
  prompt,
  responseMimeType,
  onPartial,
}: {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  responseMimeType: 'text/plain' | 'application/json';
  onPartial?: (partial: string) => void;
}) : Promise<{ text: string, lobstertrap?: any }> => {
  const response = await fetch(`${normalizeProviderUrl(baseUrl)}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {}),
    },
    body: JSON.stringify({
      model,
      temperature: FACTUAL_TEMPERATURE,
      stream: Boolean(onPartial),
      ...(responseMimeType === 'application/json'
        ? {
            response_format: {
              type: 'json_object',
            },
          }
        : {}),
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
      // LOBSTER TRAP: Declare Intent for Enterprise Security & Compliance
      _lobstertrap: {
        declared_intent: 'enterprise_automation',
        agent_id: 'catog-agent-v2',
        compliance_mode: 'strict-legal',
        features: ['hallucination_detection', 'dpi_inspection'],
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Local AI request failed: ${await response.text()}`);
  }

  if (!onPartial) {
    const payload = await response.json() as {
      choices?: Array<{
        message?: {
          content?: string | Array<{ text?: string }>;
        };
      }>;
      _lobstertrap?: any; // Capture Security Verdict
    };
    
    // Check if Lobster Trap blocked the request
    if (payload._lobstertrap?.verdict === 'DENY') {
      return { 
        text: `[LEGAL COMPLIANCE BLOCK]: ${payload._lobstertrap.ingress?.deny_message || 'This request was blocked by local security policy.'}`,
        lobstertrap: payload._lobstertrap 
      };
    }

    const text = extractAssistantText(payload.choices?.[0]?.message?.content);
    if (!text) {
      throw new Error('Local AI endpoint returned no assistant content.');
    }
    return { text, lobstertrap: payload._lobstertrap };
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('Local AI endpoint did not return a readable response stream.');
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let accumulated = '';
  let lastLobstertrap = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine.startsWith('data:')) {
        continue;
      }

      const data = trimmedLine.slice(5).trim();
      if (!data || data === '[DONE]') {
        continue;
      }

      const payload = JSON.parse(data) as {
        choices?: Array<{
          delta?: {
            content?: string | Array<{ text?: string }>;
          };
          message?: {
            content?: string | Array<{ text?: string }>;
          };
        }>;
        _lobstertrap?: any;
      };

      if (payload._lobstertrap) {
        lastLobstertrap = payload._lobstertrap;
      }

      const chunkText = extractAssistantText(payload.choices?.[0]?.delta?.content)
        || extractAssistantText(payload.choices?.[0]?.message?.content);
      if (!chunkText) {
        continue;
      }

      accumulated += chunkText;
      onPartial(accumulated);
    }
  }

  if (!accumulated.trim()) {
    throw new Error('Local AI endpoint returned an empty response.');
  }

  return { text: accumulated, lobstertrap: lastLobstertrap };
};

export const generateAgentContent = async (
  agentConfig: AgentConfig,
  prompt: string,
  responseMimeType: 'text/plain' | 'application/json',
  onPartial?: (partial: string) => void,
  options?: { forceGemini?: boolean },
): Promise<{ text: string, lobstertrap?: any }> => {
  const model = agentConfig.model || DEFAULT_LOCAL_AGENT_MODEL;
  const providerType = resolveAgentProviderType(agentConfig);

  if (providerType === 'openai-compatible' && !options?.forceGemini) {
    const baseUrl = normalizeProviderUrl(agentConfig.providerUrl || DEFAULT_LOCAL_AGENT_PROVIDER_URL);
    return readOpenAiCompatibleContent({
      baseUrl,
      apiKey: agentConfig.apiKey || '',
      model,
      prompt,
      responseMimeType,
      onPartial,
    });
  }

  const apiKey = getGeminiApiKey(agentConfig.apiKey);
  if (!apiKey) {
    throw new Error('No AI provider is configured. Use the local OpenAI-compatible endpoint or add a Gemini API key.');
  }

  const ai = new GoogleGenAI({ apiKey });
  if (!onPartial) {
    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        responseMimeType,
        temperature: FACTUAL_TEMPERATURE,
      },
    });
    return { text: response.text || '' };
  }

  const stream = await ai.models.generateContentStream({
    model,
    contents: prompt,
    config: {
      responseMimeType,
      temperature: FACTUAL_TEMPERATURE,
    },
  });

  let accumulated = '';
  for await (const chunk of stream) {
    const piece = chunk.text || '';
    if (!piece) {
      continue;
    }
    accumulated += piece;
    onPartial(accumulated);
  }

  return { text: accumulated };
};

export const verifyOpenAiCompatibleConfiguration = async (
  providerUrl: string,
  apiKey = '',
) => {
  const normalizedProviderUrl = normalizeProviderUrl(providerUrl);
  if (!normalizedProviderUrl) {
    throw new Error('A local/OpenAI-compatible provider URL is required before models can be loaded.');
  }

  const response = await fetch(`${normalizedProviderUrl}/models`, {
    headers: {
      ...(apiKey.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {}),
    },
  });
  const payload = await response.json() as OpenAiModelsResponse;

  if (!response.ok) {
    throw new Error(payload.error?.message || 'Local AI model discovery failed.');
  }

  const models = (payload.data || [])
    .map((entry) => entry.id?.trim() || '')
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));

  return {
    models,
    message: models.length > 0
      ? `Verified local AI access. ${models.length} model(s) available.`
      : 'Verified local AI access, but the endpoint did not return any models.',
  };
};

export const parseJsonResponseText = <T>(text: string): T => {
  const trimmed = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const objectStart = trimmed.indexOf('{');
  const arrayStart = trimmed.indexOf('[');
  const starts = [objectStart, arrayStart].filter((index) => index >= 0);
  const start = starts.length > 0 ? Math.min(...starts) : -1;
  const objectEnd = trimmed.lastIndexOf('}');
  const arrayEnd = trimmed.lastIndexOf(']');
  const end = Math.max(objectEnd, arrayEnd);
  const jsonText = start >= 0 && end >= start
    ? trimmed.slice(start, end + 1)
    : trimmed;
  return JSON.parse(jsonText) as T;
};
