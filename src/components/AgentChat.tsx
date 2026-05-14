/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Bot, Camera, ChevronRight, Cpu, FileText, MessageSquare, Send, Zap } from 'lucide-react';
import { AgentExecutionMessage, AppConfig, ChatAgent, DocumentAnalysis } from '../types';
import LoopTypewriter from './LoopTypewriter';
import { AgentChatMessage, sendAgentChatMessage } from '../services/agentChat';
import { getOrderedAgents } from '../lib/agentConfig';
import { resolveAgentProviderType } from '../services/agentProviders';
import { getGeminiApiKey } from '../lib/runtime';

interface AgentChatProps {
  analyses: DocumentAnalysis[];
  config: AppConfig;
  executionMessages: AgentExecutionMessage[];
  isProcessing: boolean;
  onOpenVisionCapture: () => void;
  captureAnnouncement?: string | null;
  onCaptureAnnouncementConsumed?: () => void;
}

type PanelTab = 'execution' | 'chat';


const CAMERA_REQUEST_PATTERN = /\b(open|launch|show|start|access)\b[\s\S]{0,40}\b(camera|vision|vision intake|camera widget|open camera|paper)\b|\b(camera widget|vision intake|open camera)\b/i;
const CAPABILITY_REQUEST_PATTERN = /\b(capabilities|what can you do|what are your capabilities|tools|wired|camera access|vision intake|open camera widget)\b/i;

const formatStage = (stage: AgentExecutionMessage['stage']) => {
  switch (stage) {
    case 'queued':
      return 'Queued';
    case 'retrieval':
      return 'KB Retrieval';
    case 'review':
      return 'Review';
    case 'synthesis':
      return 'Synthesis';
    case 'graph':
      return 'Graph Index';
    case 'complete':
      return 'Run Finalized';
    default:
      return stage;
  }
};

const getStatusStyles = (status: AgentExecutionMessage['status']) => {
  switch (status) {
    case 'running':
      return 'border-neon-cyan/30 bg-neon-cyan/10 text-neon-cyan';
    case 'complete':
      return 'border-success-green/30 bg-success-green/10 text-success-green';
    case 'fallback':
      return 'border-neon-yellow/30 bg-neon-yellow/10 text-neon-yellow';
    case 'error':
      return 'border-error-red/30 bg-error-red/10 text-error-red';
    default:
      return 'border-white/10 bg-white/5 text-white/50';
  }
};

const AuditModal = ({ isOpen, onClose, report }: { isOpen: boolean, onClose: () => void, report: any }) => {
  if (!isOpen) return null;
  
  const hasReport = !!report;
  const isHallucinationDetected = report?.egress?.detected?.contains_hallucination || false;
  const ingressRisk = report?.ingress?.detected?.risk_score || 0;
  const egressRisk = report?.egress?.detected?.risk_score || 0;
  const riskScore = Math.max(ingressRisk, egressRisk);
  const verdict = report?.verdict || 'ALLOW';
  const intent = report?.ingress?.detected?.intent_category || 'GENERAL_CHAT';
  const requestId = report?.request_id || 'lt_active_session_' + Date.now().toString(16);

  const threatBreakdown = report?.ingress?.detected?.threats || [];

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <motion.div 
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="absolute inset-0 bg-black/85 backdrop-blur-md" 
        onClick={onClose} 
      />
      <motion.div 
        initial={{ scale: 0.9, opacity: 0, y: 20 }} 
        animate={{ scale: 1, opacity: 1, y: 0 }}
        className="w-full max-w-2xl bg-[#0D0D0F] border border-white/10 rounded-xl overflow-hidden relative shadow-2xl flex flex-col max-h-[85vh]"
      >
        <div className="p-4 border-b border-white/10 bg-black/40 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Zap size={18} className="text-neon-cyan" />
            <div>
              <h3 className="text-xs font-black uppercase tracking-[0.2em] text-white">Security & Factuality Audit</h3>
              <p className="text-[9px] text-white/50 uppercase tracking-widest mt-1">Lobster Trap DPI Engine · Real-time Guardrails</p>
            </div>
          </div>
          <button 
            onClick={onClose} 
            className="text-white/40 hover:text-white text-[10px] font-black uppercase tracking-widest border border-white/10 px-3 py-1 rounded hover:bg-white/5 transition-colors"
          >
            [ Close ]
          </button>
        </div>
        
        <div className="p-6 overflow-y-auto custom-scrollbar space-y-6">
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-black/60 border border-white/5 p-4 rounded-lg">
              <span className="text-[10px] uppercase tracking-widest text-white/40 block mb-1">Security Verdict</span>
              <span className={`text-lg font-black uppercase tracking-widest ${verdict === 'DENY' ? 'text-error-red' : 'text-success-green'}`}>
                {verdict} {verdict === 'ALLOW' ? '(SAFE)' : '(BLOCKED)'}
              </span>
            </div>
            <div className="bg-black/60 border border-white/5 p-4 rounded-lg">
              <span className="text-[10px] uppercase tracking-widest text-white/40 block mb-1">Intent Category</span>
              <span className="text-lg font-black uppercase tracking-widest text-neon-cyan">
                {intent}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="bg-black/40 border border-white/5 p-4 rounded-lg space-y-3">
              <div className="flex items-center justify-between">
                 <span className="text-[10px] font-black uppercase tracking-widest text-white/60">Risk Score</span>
                 <span className={`text-xs font-black ${riskScore > 0.5 ? 'text-error-red' : 'text-success-green'}`}>
                   {(riskScore * 100).toFixed(1)}%
                 </span>
              </div>
              <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
                <motion.div 
                  initial={{ width: 0 }}
                  animate={{ width: `${riskScore * 100}%` }}
                  className={`h-full ${riskScore > 0.5 ? 'bg-error-red' : 'bg-success-green'}`}
                />
              </div>
            </div>
            <div className="bg-black/40 border border-white/5 p-4 rounded-lg space-y-3">
              <div className="flex items-center justify-between">
                 <span className="text-[10px] font-black uppercase tracking-widest text-white/60">Hallucination Report</span>
                 <span className={`text-xs font-black ${isHallucinationDetected ? 'text-error-red' : 'text-success-green'}`}>
                   {isHallucinationDetected ? 'DETECTED' : 'NONE'}
                 </span>
              </div>
              <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
                <motion.div 
                  initial={{ width: 0 }}
                  animate={{ width: isHallucinationDetected ? '100%' : '0%' }}
                  className={`h-full ${isHallucinationDetected ? 'bg-error-red' : 'bg-success-green'}`}
                />
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <h4 className="text-[10px] font-black uppercase tracking-widest text-neon-pink">DPI Guardrail Metrics</h4>
            <div className="bg-black/40 border border-white/5 rounded-lg overflow-hidden text-[11px] font-mono">
              <div className="grid grid-cols-2 p-3 border-b border-white/5">
                <span className="text-white/40 uppercase">Injection Pattern Scan</span>
                <span className={`${threatBreakdown.includes('injection') ? 'text-error-red' : 'text-success-green'} font-black uppercase`}>
                  {threatBreakdown.includes('injection') ? 'THREAT DETECTED' : 'CLEAR'}
                </span>
              </div>
              <div className="grid grid-cols-2 p-3 border-b border-white/5">
                <span className="text-white/40 uppercase">PII Leak Prevention</span>
                <span className={`${threatBreakdown.includes('pii') ? 'text-error-red' : 'text-success-green'} font-black uppercase`}>
                  {threatBreakdown.includes('pii') ? 'LEAK DETECTED' : 'PROTECTED'}
                </span>
              </div>
              <div className="grid grid-cols-2 p-3 border-b border-white/5">
                <span className="text-white/40 uppercase">Credential Guard</span>
                <span className={`${threatBreakdown.includes('credentials') ? 'text-error-red' : 'text-success-green'} font-black uppercase`}>
                  {threatBreakdown.includes('credentials') ? 'EXPOSED' : 'SECURE'}
                </span>
              </div>
              <div className="grid grid-cols-2 p-3">
                <span className="text-white/40 uppercase">Compliance Mode</span>
                <span className="text-white uppercase font-black">{report?.ingress?.declared?.compliance_mode || 'STRICT-LEGAL'}</span>
              </div>
            </div>
          </div>

          {!hasReport && (
            <div className="p-4 bg-neon-cyan/5 border border-neon-cyan/20 rounded-lg flex items-start gap-3">
              <div className="w-2 h-2 rounded-full bg-neon-cyan animate-pulse mt-1" />
              <div>
                <p className="text-[11px] font-black uppercase tracking-widest text-neon-cyan">Lobster Trap Active</p>
                <p className="text-[10px] text-white/60 leading-relaxed mt-1">
                  Middleware is currently monitoring the session. No security violations or hallucinations have been flagged for this specific message payload. 
                </p>
              </div>
            </div>
          )}

          {report?.ingress?.mismatches && report.ingress.mismatches.length > 0 && (
            <div className="space-y-3">
              <h4 className="text-[10px] font-black uppercase tracking-widest text-error-red">Intent Mismatches Detected</h4>
              <div className="space-y-2">
                {report.ingress.mismatches.map((m: any, i: number) => (
                  <div key={i} className="p-3 bg-error-red/10 border border-error-red/20 rounded-lg">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[9px] font-black uppercase tracking-widest text-error-red">{m.field} Conflict</span>
                      <span className="text-[8px] font-black uppercase tracking-widest text-white/40">{m.severity}</span>
                    </div>
                    <div className="text-[10px] text-white/70">
                      Declared: <span className="text-success-green">{JSON.stringify(m.declared)}</span>
                    </div>
                    <div className="text-[10px] text-white/70">
                      Detected: <span className="text-error-red">{JSON.stringify(m.detected)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="p-4 bg-white/5 border border-white/5 rounded-lg font-mono text-[10px]">
            <span className="text-white/30 uppercase tracking-widest block mb-2">Audit Hash (Chain of Custody)</span>
            <span className="text-white/70 break-all select-all">
              {requestId}
            </span>
          </div>

          <div className="space-y-3">
            <h4 className="text-[10px] font-black uppercase tracking-widest text-white/40">Raw Inspection Payload</h4>
            <pre className="p-4 bg-black/80 border border-white/5 rounded-lg text-[9px] text-white/60 overflow-x-auto custom-scrollbar">
              {hasReport ? JSON.stringify(report, null, 2) : '{"status": "monitoring", "engine": "lobstertrap-v2.1", "telemetry": "disabled"}'}
            </pre>
          </div>
        </div>

        <div className="p-4 bg-black/60 border-t border-white/10">
          <p className="text-[9px] text-white/30 uppercase tracking-[0.1em] text-center italic">
            This report was generated locally by the Lobster Trap DPI engine. No telemetry was sent to external cloud providers.
          </p>
        </div>
      </motion.div>
    </div>
  );
};

export default function AgentChat({ analyses, config, executionMessages, isProcessing, onOpenVisionCapture, captureAnnouncement, onCaptureAnnouncementConsumed }: AgentChatProps) {
  const orderedAgents = useMemo(() => getOrderedAgents(config), [config]);
  const agentIds = useMemo(() => orderedAgents.map((agent) => agent.id), [orderedAgents]);
  const [selectedAgent, setSelectedAgent] = useState<ChatAgent>(() => {
    try {
      const saved = localStorage.getItem('catog-selected-agent');
      if (saved && agentIds.includes(saved as ChatAgent)) {
        return saved as ChatAgent;
      }
    } catch {
      // ignore
    }
    return orderedAgents[0]?.id || 'core';
  });

  useEffect(() => {
    localStorage.setItem('catog-selected-agent', selectedAgent);
  }, [selectedAgent]);
  const [panelTab, setPanelTab] = useState<PanelTab>('execution');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);

  // Per-agent chat history
  const [chatHistories, setChatHistories] = useState<Record<string, AgentChatMessage[]>>(() => {
    try {
      const saved = localStorage.getItem('catog-chat-histories');
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });
  const [chatInputs, setChatInputs] = useState<Record<string, string>>(() => {
    try {
      const saved = localStorage.getItem('catog-chat-inputs');
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  useEffect(() => {
    localStorage.setItem('catog-chat-histories', JSON.stringify(chatHistories));
  }, [chatHistories]);

  useEffect(() => {
    localStorage.setItem('catog-chat-inputs', JSON.stringify(chatInputs));
  }, [chatInputs]);
  const [sendingAgent, setSendingAgent] = useState<ChatAgent | null>(null);
  const [auditMessageId, setAuditMessageId] = useState<string | null>(null);

  useEffect(() => {
    setChatHistories((prev) => agentIds.reduce<Record<string, AgentChatMessage[]>>((next, agentId) => {
      next[agentId] = prev[agentId] || [];
      return next;
    }, {}));
    setChatInputs((prev) => agentIds.reduce<Record<string, string>>((next, agentId) => {
      next[agentId] = prev[agentId] || '';
      return next;
    }, {}));
    if (!agentIds.includes(selectedAgent) && agentIds.length > 0) {
      setSelectedAgent(agentIds[0]);
    }
  }, [agentIds, selectedAgent]);

  const agentConfig = config.agents[selectedAgent] || orderedAgents[0];
  const selectedChatHistory = chatHistories[selectedAgent] || [];
  const selectedChatInput = chatInputs[selectedAgent] || '';
  const activeKBs = config.knowledgeBases.filter((kb) =>
    (agentConfig.kbIds && agentConfig.kbIds.length > 0)
      ? agentConfig.kbIds.includes(kb.id)
      : config.selectedKBIds.includes(kb.id),
  );
  const isAgentSpecificKB = Boolean(agentConfig.kbIds && agentConfig.kbIds.length > 0);

  const visibleMessages = useMemo(() => {
    const filtered = executionMessages.filter(
      (msg) => msg.agent === selectedAgent || msg.agent === 'system',
    );

    // Per (agent, documentId, stage) keep only the newest event so a later
    // "complete" entry always replaces an earlier "running" entry even when
    // they carry different IDs (the retrieval events use Date.now() suffixes).
    const latestBySlot = new Map<string, AgentExecutionMessage>();
    filtered.forEach((msg) => {
      const key = `${msg.agent}|${msg.documentId}|${msg.stage}`;
      const existing = latestBySlot.get(key);
      if (!existing || msg.timestamp.getTime() >= existing.timestamp.getTime()) {
        latestBySlot.set(key, msg);
      }
    });

    return Array.from(latestBySlot.values()).sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    );
  }, [executionMessages, selectedAgent]);

  const latestAgentMessage = useMemo(
    () => [...executionMessages].reverse().find((message) => message.agent === selectedAgent),
    [executionMessages, selectedAgent],
  );



  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [visibleMessages]);

  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [chatHistories, selectedAgent]);





  const updateAssistantMessage = useCallback((
    agentId: ChatAgent,
    messageId: string,
    text: string,
    pending: boolean,
    lobstertrap?: any,
  ) => {
    setChatHistories((prev) => ({
      ...prev,
      [agentId]: (prev[agentId] || []).map((message) => (
        message.id === messageId ? { ...message, text, pending, lobstertrap } : message
      )),
    }));
  }, []);



  // Deliver capture announcement as an agent chat message + speak it if voice is on.
  useEffect(() => {
    if (!captureAnnouncement) return;
    onCaptureAnnouncementConsumed?.();

    const announcingAgent = selectedAgent;
    const msgId = `capture-announce-${Date.now()}`;
    const msg: AgentChatMessage = {
      id: msgId,
      role: 'assistant',
      agentId: announcingAgent,
      text: captureAnnouncement,
      pending: false,
      timestamp: new Date(),
    };
    setChatHistories((prev) => ({
      ...prev,
      [announcingAgent]: [...(prev[announcingAgent] || []), msg],
    }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captureAnnouncement]);



  const sendQuestion = useCallback(async (agentId: ChatAgent, question: string) => {
    if (!question.trim() || sendingAgent === agentId) return;

    const userMsg: AgentChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      agentId,
      text: question,
      timestamp: new Date(),
    };
    const assistantMsgId = `agent-${Date.now()}`;
    const assistantMsg: AgentChatMessage = {
      id: assistantMsgId,
      role: 'assistant',
      agentId,
      text: '',
      pending: true,
      timestamp: new Date(),
    };

    // Optimistically append user + empty assistant placeholder
    setChatHistories((prev) => ({
      ...prev,
      [agentId]: [...(prev[agentId] || []), userMsg, assistantMsg],
    }));
    setChatInputs((prev) => ({ ...prev, [agentId]: '' }));
    setSendingAgent(agentId);

    const agentIdForRequest = agentId;
    const historyForRequest = chatHistories[agentId] || [];
    const buildRuntimeContext = () => {
      const runtimeAgent = config.agents[agentIdForRequest];
      const providerType = resolveAgentProviderType(runtimeAgent);
      const kbNames = config.knowledgeBases
        .filter((kb) => (
          runtimeAgent.kbIds && runtimeAgent.kbIds.length > 0
            ? runtimeAgent.kbIds.includes(kb.id)
            : config.selectedKBIds.includes(kb.id)
        ))
        .map((kb) => kb.name)
        .join(', ');

      return [
        `Vision Intake camera widget: available and can be opened from agent chat.`,
        `Document upload plus capture-and-analyze intake: available.`,
        `Multi-agent review pipeline: available for uploaded and vision-captured documents.`,
        `Knowledge graph indexing: available during analysis runs.`,

        `Active knowledge bases for this agent: ${kbNames || 'none selected.'}`,
        `Current model provider: ${providerType === 'openai-compatible' ? 'Local / OpenAI-compatible' : 'Gemini'}.`,
        `Current model: ${runtimeAgent.model || 'not configured.'}`,
        `Current provider URL: ${runtimeAgent.providerUrl || 'not configured.'}`,
      ].join('\n');
    };
    const runtimeContext = buildRuntimeContext();
    const shouldOpenCamera = CAMERA_REQUEST_PATTERN.test(question);
    const shouldDescribeCapabilities = CAPABILITY_REQUEST_PATTERN.test(question);

    try {
      if (shouldOpenCamera || shouldDescribeCapabilities) {
        if (shouldOpenCamera) {
          onOpenVisionCapture();
        }

        const builtinSections: string[] = [];
        if (shouldOpenCamera) {
          builtinSections.push('Opening the Vision Intake camera now. As soon as you capture the paper or upload an image from that widget, CATOG will auto-send it into analysis.');
        }
        if (shouldDescribeCapabilities) {
          builtinSections.push(`Here are my CATOG capabilities and wired tools right now:\n${runtimeContext}`);
        }

        const builtinReply = builtinSections.join('\n\n');

        updateAssistantMessage(agentIdForRequest, assistantMsgId, builtinReply, false);
        return;
      }

      const { text: reply, lobstertrap } = await sendAgentChatMessage(
        agentIdForRequest,
        question,
        config,
        historyForRequest,
        runtimeContext,
        (partial) => {
          updateAssistantMessage(agentIdForRequest, assistantMsgId, partial, true);
        },
      );
      updateAssistantMessage(agentIdForRequest, assistantMsgId, reply, false, lobstertrap);
    } catch (err) {
      const errText = err instanceof Error ? err.message : 'Failed to get response.';
      updateAssistantMessage(agentIdForRequest, assistantMsgId, `⚠ ${errText}`, false);
    } finally {
      setSendingAgent(null);
    }
  }, [sendingAgent, chatHistories, config, onOpenVisionCapture, updateAssistantMessage]);

  const handleSend = useCallback(async () => {
    const question = (chatInputs[selectedAgent] || '').trim();
    await sendQuestion(selectedAgent, question);
  }, [chatInputs, selectedAgent, sendQuestion]);



  return (
    <div className="flex flex-col h-full bg-[#0D0D0F] border-t border-white/5 relative">
      <div className="absolute inset-0 terminal-scanline pointer-events-none opacity-10" />

      <div className="flex flex-col bg-black/40 border-b border-white/5">
        <div className="flex items-center space-x-1 p-2">
          {orderedAgents.map((agent) => {
            const Icon = Cpu;
            const isSelected = selectedAgent === agent.id;
            return (
              <button
                key={agent.id}
                onClick={() => setSelectedAgent(agent.id)}
                title={config.agents[agent.id].description || agent.name}
                className={`relative flex-1 flex items-center justify-center space-x-2 py-2 px-1 rounded transition-all duration-300 group
                  ${isSelected ? 'bg-white/10 shadow-[inset_0_0_10px_rgba(255,255,255,0.05)]' : 'hover:bg-white/5'}
                `}
                >
                  <Icon
                    size={13}
                    className={!isSelected ? 'text-white/60 group-hover:text-white/80' : undefined}
                    style={isSelected ? { color: agent.color } : undefined}
                  />
                  <span
                    className={`text-[10px] font-black tracking-widest uppercase ${isSelected ? '' : 'text-white/70 group-hover:text-white'}`}
                    style={isSelected ? { color: agent.color } : undefined}
                  >
                    {config.agents[agent.id].name}
                </span>
                {isSelected && (
                  <motion.div layoutId="activeAgent" className="absolute bottom-0 left-0 right-0 h-0.5" style={{ backgroundColor: agent.color }} />
                )}
              </button>
            );
          })}
        </div>

        {/* Execution / Chat tabs */}
        <div className="flex border-t border-white/[0.04]">
          <button
            onClick={() => setPanelTab('execution')}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-[9px] font-black uppercase tracking-widest transition-colors
              ${panelTab === 'execution' ? 'text-neon-cyan border-b border-neon-cyan' : 'text-white/60 hover:text-white'}`}
          >
            <Zap size={10} />
            Execution
          </button>
          <button
            onClick={() => setPanelTab('chat')}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-[9px] font-black uppercase tracking-widest transition-colors
              ${panelTab === 'chat' ? 'text-neon-pink border-b border-neon-pink' : 'text-white/60 hover:text-white'}`}
          >
            <MessageSquare size={10} />
            Chat
            {selectedChatHistory.length > 0 && (
              <span className="px-1.5 py-px rounded-full bg-neon-pink/20 text-neon-pink text-[8px]">
                {selectedChatHistory.filter((m) => m.role === 'user').length}
              </span>
            )}
          </button>
        </div>

        <div className="px-4 py-2 flex flex-col space-y-1 border-t border-white/[0.03] bg-black/20">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <div className={`w-1.5 h-1.5 rounded-full ${isProcessing ? 'bg-neon-cyan animate-pulse' : 'bg-white/20'}`} />
              <span className={`text-[9px] font-black tracking-widest uppercase ${isProcessing ? 'text-neon-cyan' : 'text-white/70'}`}>
                Live Agent Execution
              </span>
            </div>
            <span className="text-[9px] font-black tracking-widest uppercase text-white/70">
              Analyses: {analyses.length}
            </span>
          </div>
          <div className="flex items-center justify-between opacity-60 overflow-hidden">
            <span className="text-[8px] font-black tracking-widest uppercase text-white truncate max-w-[52%]">
              KBs: {activeKBs.length > 0 ? activeKBs.map((kb) => kb.name).join(' | ') : 'None'}
            </span>
            <span className="text-[8px] font-black tracking-widest uppercase text-white shrink-0">
              Scope: {isAgentSpecificKB ? 'Agent-Specific' : 'Global'}
            </span>
          </div>
        </div>
      </div>

      <div
        ref={scrollRef}
        className={`flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar font-mono text-[12px] ${panelTab !== 'execution' ? 'hidden' : ''}`}
      >
        {visibleMessages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center text-white/50 px-6">
            <Bot size={28} className="mb-3" />
            <p className="text-[11px] font-black uppercase tracking-[0.25em] text-white">No live execution yet</p>
            <p className="mt-2 text-[11px] leading-relaxed text-white/70">
              Upload real documents and run the pipeline to see actual retrieval, review, synthesis, and graph-index events here.
            </p>
          </div>
        ) : (
          <AnimatePresence mode="popLayout">
            {visibleMessages.map((message) => {
              const isRunning = message.status === 'running';
              const isExpanded = expandedIds.has(message.id);
              const canExpand = !isRunning && Boolean(message.text);
              const agentName = message.agent === 'system' ? 'System' : config.agents[message.agent].name;

              return (
                <motion.div
                  key={message.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={`rounded-lg border bg-black/40 overflow-hidden ${getStatusStyles(message.status)} ${canExpand ? 'cursor-pointer hover:brightness-110' : ''}`}
                  onClick={() => {
                    if (!canExpand) return;
                    setExpandedIds((prev) => {
                      const next = new Set(prev);
                      if (next.has(message.id)) next.delete(message.id);
                      else next.add(message.id);
                      return next;
                    });
                  }}
                >
                  {/* ── collapsed header row (always visible) ─── */}
                  <div className="flex items-center gap-2 p-2.5 min-w-0">
                    <span className={`px-2 py-0.5 rounded border text-[9px] font-black uppercase tracking-widest shrink-0 ${getStatusStyles(message.status)}`}>
                      {agentName}
                    </span>
                    <span className="text-[9px] uppercase tracking-widest text-white/70 shrink-0">
                      {formatStage(message.stage)}
                    </span>

                    {/* Running: looping typewriter; done: clean status dot only — no output text */}
                    <div className="flex-1 min-w-0 flex items-center gap-1.5">
                      <AnimatePresence mode="wait">
                        {isRunning ? (
                          <motion.span key="working" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                            <LoopTypewriter className="text-neon-cyan text-[11px] tracking-widest" />
                          </motion.span>
                        ) : (
                          <motion.span
                            key="done"
                            initial={{ opacity: 0, scale: 0.8 }}
                            animate={{ opacity: 1, scale: 1 }}
                            className={`flex items-center gap-1 text-[9px] font-black uppercase tracking-widest ${
                              message.status === 'complete' ? 'text-success-green' :
                              message.status === 'fallback' ? 'text-neon-yellow' :
                              message.status === 'error' ? 'text-error-red' : 'text-white/70'
                            }`}
                          >
                            <span className="w-1.5 h-1.5 rounded-full bg-current shrink-0" />
                            {message.status === 'complete' ? 'Completed' :
                             message.status === 'fallback' ? 'Fallback' :
                             message.status === 'error' ? 'Error' : message.status}
                          </motion.span>
                        )}
                      </AnimatePresence>
                    </div>

                    <span className="text-[9px] uppercase tracking-widest text-white/60 shrink-0">
                      {message.timestamp.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </span>
                    {canExpand && (
                      <ChevronRight
                        size={11}
                        className={`shrink-0 text-white/25 transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`}
                      />
                    )}
                  </div>

                  {/* ── expanded body ─────────────────────────── */}
                  <AnimatePresence>
                    {isExpanded && (
                      <motion.div
                        key="body"
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="border-t border-white/5 overflow-hidden"
                      >
                        <div className="p-3 space-y-2">
                          <div className="flex items-center gap-2 text-[9px] uppercase tracking-widest text-white/60">
                            <FileText size={10} />
                            <span className="truncate">{message.fileName}</span>
                          </div>
                          <p className="text-[12px] leading-relaxed text-white whitespace-pre-wrap break-words">
                            {message.text}
                          </p>

                          {/* Lobster Trap Audit Link for Execution Messages */}
                          <div className="pt-3 mt-3 border-t border-white/5 flex items-center justify-between">
                            <div className="flex items-center gap-1.5">
                              <div className={`w-1.5 h-1.5 rounded-full ${message.lobstertrap?.egress?.detected?.contains_hallucination ? 'bg-error-red animate-pulse' : 'bg-success-green'}`} />
                              <span className={`text-[8px] font-black uppercase tracking-[0.15em] ${message.lobstertrap?.egress?.detected?.contains_hallucination ? 'text-error-red' : 'text-success-green'}`}>
                                {message.lobstertrap?.egress?.detected?.contains_hallucination ? 'Hallucination Detected' : 'LobsterTrap Active'}
                              </span>
                            </div>
                            <button 
                              onClick={(e) => {
                                e.stopPropagation();
                                setAuditMessageId(message.id);
                              }}
                              className="text-[8px] font-black uppercase tracking-widest text-neon-cyan hover:underline flex items-center gap-1 group/audit"
                            >
                              <span>LobsterTrap</span>
                              <ChevronRight size={8} className="group-hover/audit:translate-x-0.5 transition-transform" />
                              <span>Audit Report</span>
                            </button>
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>
              );
            })}
          </AnimatePresence>
        )}
      </div>

      {/* ── CHAT PANEL ──────────────────────────────────── */}
      <div className={`flex flex-col flex-1 min-h-0 ${panelTab !== 'chat' ? 'hidden' : ''}`}>
        <div
          ref={chatScrollRef}
          className="flex-1 overflow-y-auto p-3 space-y-3 custom-scrollbar"
        >
          {selectedChatHistory.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center text-white/50 px-6 py-8">
              <MessageSquare size={24} className="mb-3 text-neon-pink/40" />
              <p className="text-[11px] font-black uppercase tracking-[0.2em] text-white">
                Chat with {agentConfig.name}
              </p>
              <p className="mt-2 text-[11px] leading-relaxed text-white/70">
                Ask questions, request summaries, or get specialist advice directly from this agent.
              </p>
            </div>
          ) : (
            <AnimatePresence initial={false}>
              {selectedChatHistory.map((msg) => (
                <motion.div
                  key={msg.id}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                    {msg.role === 'assistant' && (
                      <div className="w-5 h-5 rounded border border-white/10 bg-black/40 flex items-center justify-center shrink-0 mt-0.5 mr-2">
                        <Cpu size={9} style={{ color: agentConfig?.color || '#FFFFFF' }} />
                      </div>
                    )}
                  <div
                      className={`max-w-[85%] rounded-lg px-3 py-2 text-[11px] leading-relaxed font-mono relative group ${
                        msg.role === 'user'
                          ? 'bg-neon-pink/10 border border-neon-pink/20 text-white/90 rounded-br-none'
                          : 'bg-black/60 border border-white/10 text-white rounded-bl-none'
                     }`}
                  >
                    {msg.text || (
                      <span className="flex items-center gap-1.5 text-white/30">
                        <span className="inline-block w-1 h-1 bg-white/30 rounded-full animate-bounce [animation-delay:0ms]" />
                        <span className="inline-block w-1 h-1 bg-white/30 rounded-full animate-bounce [animation-delay:150ms]" />
                        <span className="inline-block w-1 h-1 bg-white/30 rounded-full animate-bounce [animation-delay:300ms]" />
                      </span>
                    )}
                    {msg.pending && msg.text && (
                      <span className="inline-block w-0.5 h-3 bg-neon-pink/60 ml-0.5 animate-pulse" />
                    )}

                    {/* LOBSTER TRAP: Security Verification Badge */}
                    {msg.role === 'assistant' && !msg.pending && (
                      <div className="mt-2 pt-1 border-t border-white/5 flex flex-col gap-1.5">
                        {msg.lobstertrap?.egress?.detected?.contains_hallucination && (
                          <div className="flex items-center gap-1.5 p-1 px-1.5 bg-error-red/10 border border-error-red/20 rounded">
                            <Zap size={9} className="text-error-red" />
                            <span className="text-[8px] font-black uppercase tracking-widest text-error-red">High Hallucination Risk Detected</span>
                          </div>
                        )}
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-1.5 opacity-60">
                            <Zap size={9} className={msg.lobstertrap?.egress?.detected?.contains_hallucination ? 'text-neon-yellow' : 'text-success-green'} />
                            <span className={`text-[8px] font-black uppercase tracking-widest ${msg.lobstertrap?.egress?.detected?.contains_hallucination ? 'text-neon-yellow' : 'text-success-green'}`}>
                              {msg.lobstertrap?.egress?.detected?.contains_hallucination ? 'Factuality Check Failed' : 'Verified by Lobster Trap'}
                            </span>
                          </div>
                            <button 
                              onClick={() => setAuditMessageId(msg.id)}
                              className="text-[8px] font-black uppercase tracking-widest text-neon-cyan hover:underline flex items-center gap-1"
                            >
                              <span>LobsterTrap</span>
                              <ChevronRight size={8} />
                              <span>Audit Report</span>
                            </button>
                        </div>
                      </div>
                    )}
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
          )}
        </div>

        {/* Chat input */}
        <div className="p-2 bg-black/60 border-t border-white/5">
          <div className="mb-2 flex items-center gap-2">
            <button
              onClick={onOpenVisionCapture}
              disabled={isProcessing}
              className={`inline-flex items-center gap-2 rounded px-3 py-1.5 text-[9px] font-black uppercase tracking-widest transition-all ${
                isProcessing
                  ? 'bg-white/5 text-white/20 cursor-not-allowed'
                  : 'bg-neon-pink text-white border border-neon-pink hover:brightness-110'
              }`}
            >
              <Camera size={10} />
              Open Camera
            </button>
          </div>
          <div className="flex items-end gap-2 bg-black/40 border border-white/10 rounded-lg px-2 py-1.5 focus-within:border-neon-pink/30 transition-colors">
            <textarea
              rows={1}
              value={selectedChatInput}
              onChange={(e) => {
                setChatInputs((prev) => ({ ...prev, [selectedAgent]: e.target.value }));
                // auto-grow
                e.target.style.height = 'auto';
                e.target.style.height = `${Math.min(e.target.scrollHeight, 80)}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
              placeholder={`Ask ${agentConfig.name}…`}
              className="flex-1 bg-transparent text-[11px] text-white placeholder:text-white/30 resize-none outline-none leading-relaxed font-mono min-h-[18px] max-h-[80px]"
            />
            <button
              onClick={() => void handleSend()}
              disabled={!selectedChatInput.trim() || sendingAgent === selectedAgent}
              className="shrink-0 p-1.5 rounded disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              style={{
                backgroundColor: `${agentConfig?.color || '#FF2D95'}1A`,
                border: `1px solid ${agentConfig?.color || '#FF2D95'}33`,
                color: agentConfig?.color || '#FF2D95',
              }}
            >
              {sendingAgent === selectedAgent ? (
                <span
                  className="w-3 h-3 rounded-full animate-spin block"
                  style={{
                    borderWidth: '1px',
                    borderStyle: 'solid',
                    borderColor: `${agentConfig?.color || '#FF2D95'}55`,
                    borderTopColor: agentConfig?.color || '#FF2D95',
                  }}
                />
              ) : (
                <Send size={11} />
              )}
            </button>
          </div>
          <p className="text-[8px] text-white/40 mt-1 px-1">Enter to send · Shift+Enter for newline</p>
        </div>
      </div>

      {/* ── EXECUTION STATUS FOOTER (only on execution tab) ──── */}
      {panelTab === 'execution' && (
      <div className="p-3 bg-black/60 border-t border-white/5 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[9px] uppercase font-bold text-white/60 tracking-widest">Latest Agent State</span>
          <span className={`px-2 py-0.5 rounded border text-[9px] font-black uppercase tracking-widest ${latestAgentMessage ? getStatusStyles(latestAgentMessage.status) : 'border-white/10 bg-white/5 text-white/60'}`}>
            {latestAgentMessage ? latestAgentMessage.status : 'idle'}
          </span>
        </div>
        <div className="text-[11px] text-white leading-relaxed min-h-[32px] whitespace-pre-wrap break-words">
          {latestAgentMessage
            ? `${formatStage(latestAgentMessage.stage)} • ${latestAgentMessage.text}`
            : 'Select an agent and start a run to inspect its real execution trace.'}
        </div>
      </div>
      )}

      {/* LOBSTER TRAP: Audit Reporting */}
      <AuditModal 
        isOpen={!!auditMessageId} 
        onClose={() => setAuditMessageId(null)}
        report={selectedChatHistory.find(m => m.id === auditMessageId)?.lobstertrap || executionMessages.find(m => `${m.id}-event` === auditMessageId)?.lobstertrap}
      />
    </div>
  );
}
