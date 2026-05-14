/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { AppConfig, ChatAgent } from '../types';
import { DEFAULT_LOCAL_AGENT_MODEL, generateAgentContent } from './agentProviders';
import { formatKnowledgeBaseContext, queryKnowledgeBases } from './knowledgeBase';

export interface AgentChatMessage {
  id: string;
  role: 'user' | 'assistant';
  agentId: ChatAgent;
  text: string;
  /** still streaming */
  pending?: boolean;
  timestamp: Date;
  /** LOBSTER TRAP: Security & Compliance Audit Report */
  lobstertrap?: any;
}

const buildChatSystemPrompt = (
  agentName: string,
  agentRole: string,
  kbContext: string,
  runtimeContext: string,
): string =>
  `You are ${agentName}, an AI specialist agent.
Role: ${agentRole}

You are having a direct conversation with the user. Answer concisely and helpfully using only facts supported by the user input, uploaded document context, or retrieved knowledge-base evidence.
${kbContext ? `\nRelevant knowledge-base context:\n${kbContext}\n` : ''}
${runtimeContext ? `\nCATOG runtime capabilities and wired tools:\n${runtimeContext}\n` : ''}
When the user asks about your capabilities, connected tools, camera access, vision intake, reports, uploads, graph indexing, or knowledge bases, answer from the CATOG runtime context above instead of saying there is insufficient evidence.
If the user asks to open the camera or vision intake widget and that tool is listed as available, acknowledge that CATOG can open it.
If the evidence is missing or uncertain, say that there is insufficient evidence instead of guessing.
Keep answers focused and structured. Do not use markdown bullets, asterisks, or bold markers. Use plain sentences or numbered lines only.`;

/** Send a single chat message to an agent and stream the plain-text response. */
export const sendAgentChatMessage = async (
  agentId: ChatAgent,
  userMessage: string,
  config: AppConfig,
  history: AgentChatMessage[],
  runtimeContext: string,
  onChunk: (partial: string) => void,
): Promise<{ text: string, lobstertrap?: any }> => {
  const agentConfig = config.agents[agentId];
  const model = agentConfig.model || DEFAULT_LOCAL_AGENT_MODEL;

  // Load KB context relevant to this agent
  const kbIds = agentConfig.kbIds && agentConfig.kbIds.length > 0
    ? agentConfig.kbIds
    : config.selectedKBIds;
  let kbContext = '';
  try {
    const activeKBs = config.knowledgeBases.filter((kb) => kbIds.includes(kb.id));
    const lookup = await queryKnowledgeBases(activeKBs, userMessage, 3);
    kbContext = formatKnowledgeBaseContext(lookup.results);
  } catch {
    // KB is optional — carry on without it
  }

  const systemPrompt = buildChatSystemPrompt(
    agentConfig.name,
    agentConfig.role || agentConfig.description || agentConfig.name,
    kbContext,
    runtimeContext,
  );

  // Build conversation context from last 6 turns
  const recentHistory = history.slice(-6);
  const historyText = recentHistory.map((m) =>
    `${m.role === 'user' ? 'User' : agentConfig.name}: ${m.text}`,
  ).join('\n');

  const fullPrompt = `${systemPrompt}\n\n${historyText ? `Conversation so far:\n${historyText}\n\n` : ''}User: ${userMessage}\n${agentConfig.name}:`;
  const response = await generateAgentContent(
    {
      ...agentConfig,
      model,
    },
    fullPrompt,
    'text/plain',
    onChunk,
  );

  return response;
};
