/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { motion, AnimatePresence } from 'motion/react';
import { Message, AppConfig } from '../types';
import { useEffect, useRef, useState } from 'react';
import { ChevronRight, Loader2, ShieldCheck } from 'lucide-react';
import LoopTypewriter from './LoopTypewriter';
import { getAgentTextColor } from '../lib/agentConfig';

interface TerminalProps {
  messages: Message[];
  config: AppConfig;
}

function Typewriter({ text, speed = 15, isFinished = false }: { text: string; speed?: number; isFinished?: boolean }) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    setCount(isFinished ? text.length : 0);
  }, [text, isFinished]);
  
  useEffect(() => {
    if (isFinished) {
      setCount(text.length);
      return;
    }
    if (count < text.length) {
      const timer = setTimeout(() => setCount(c => c + 1), speed);
      return () => clearTimeout(timer);
    }
  }, [count, text, speed, isFinished]);

  return <span>{text.slice(0, count)}<span className={count < text.length ? "animate-pulse" : "hidden"}>|</span></span>;
}

const getAgentBadgeProps = (agent: string, config: AppConfig) => {
  if (agent === 'system') {
    return {
      className: 'font-black',
      style: { backgroundColor: '#A020F0', color: '#FFFFFF' },
    };
  }

  if (agent === 'success') {
    return {
      className: 'font-black',
      style: { backgroundColor: '#00FF88', color: '#0D0D0F' },
    };
  }

  const configuredAgent = config.agents[agent];
  if (!configuredAgent) {
    return {
      className: 'text-white/40',
      style: undefined,
    };
  }

  return {
    className: configuredAgent.kind === 'core' ? 'font-black' : '',
    style: {
      backgroundColor: configuredAgent.color,
      color: getAgentTextColor(configuredAgent.color),
    },
  };
};

const getMessageStyles = (agent: string) => {
  switch (agent) {
    case 'success':
      return 'border-success-green/30 text-success-green font-bold';
    default:
      return 'border-white/5 text-[#F2F2F2]';
  }
};

const summarizeSystemMessage = (text: string) => {
  const normalized = text.trim().replace(/^\[[A-Z]+\]\s*/, '');
  const prefix = normalized.match(/^([A-Z_]+):/)?.[1];

  switch (prefix) {
    case 'BOOT_SEQUENCE':
      return 'Initializing';
    case 'PAYLOAD_RECEIVED':
      return 'Payload Received';
    case 'GRAPH_INDEXED':
      return 'Graph Indexed';
    case 'RAG_SYNC':
      return 'RAG Sync';
    case 'RAG_WARNINGS':
      return 'RAG Warning';
    case 'HISTORY_RESTORED':
      return 'History Restored';
    case 'HISTORY_SAVE_WARNING':
      return 'Save Warning';
    case 'CONFIG_RESTORE_WARNING':
      return 'Config Warning';
    default:
      break;
  }

  if (/^Initializing ingestion/i.test(normalized)) {
    return 'Initializing';
  }
  if (/^Dispatching specialist agents/i.test(normalized)) {
    return 'Dispatching Agents';
  }
  if (/^Collecting specialist outputs/i.test(normalized)) {
    return 'Collecting Outputs';
  }
  if (/^Persisting the analysis graph/i.test(normalized)) {
    return 'Indexing Graph';
  }
  if (/^Loading embedded files/i.test(normalized)) {
    return 'Loading Files';
  }

  const compact = normalized
    .replace(/^[A-Z_]+:\s*/, '')
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join(' ');

  return compact || 'System Task';
};

const getCollapsedLabel = (msg: Message) => {
  if (msg.agent !== 'system' && msg.agent !== 'success') {
    return 'Completed Task';
  }

  if (msg.agent === 'system') {
    return summarizeSystemMessage(msg.text);
  }

  if (msg.agent === 'success') {
    if (/synthesis completed/i.test(msg.text)) {
      return 'Synthesis Done';
    }

    return 'Completed';
  }

  return 'Completed';
};

const getCollapsedStyles = (msg: Message) => {
  if (msg.agent !== 'system' && msg.agent !== 'success') {
    return 'border-success-green/30 bg-success-green/10 text-success-green hover:border-success-green/50 hover:bg-success-green/15';
  }

  if (msg.agent === 'system') {
    return 'border-white/10 bg-white/[0.03] text-white/80 hover:border-white/20 hover:bg-white/[0.05]';
  }

  if (msg.agent === 'success') {
    return 'border-success-green/30 bg-success-green/10 text-success-green hover:border-success-green/50 hover:bg-success-green/15';
  }

  return 'border-white/10 bg-white/[0.03] text-white/45 hover:border-white/20 hover:bg-white/[0.05]';
};

export default function Terminal({ messages, config }: TerminalProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const getAgentName = (agent: string) => {
    if (agent === 'success') return 'COMPLETED';
    if (agent === 'system') return 'SYSTEM';
    return config.agents[agent]?.name || agent.toUpperCase();
  };

  useEffect(() => {
    if (bottomRef.current) {
      const container = bottomRef.current.parentElement;
      if (container) {
        container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
      }
    }
  }, [messages]);

  return (
    <div className="flex-1 flex flex-col bg-[#0D0D0F] overflow-hidden relative">
      <div className="absolute inset-0 terminal-scanline pointer-events-none opacity-20" />
      
      <div className="flex-1 overflow-y-auto p-4 font-mono text-[12px] space-y-2 custom-scrollbar leading-relaxed">
        <div className="text-[#555] mb-4 uppercase tracking-widest border-b border-white/5 pb-2">[INITIALIZING_SECURITY_PROTOCOL_v.2.4]</div>
        
        <div className="flex flex-col space-y-2">
          {messages.map((msg) => {
            const isProcessing = !msg.isComplete && msg.agent !== 'system';
            const isSystemCollapsed = msg.agent === 'system' && Boolean(msg.text);
            const isSuccessCollapsed = msg.agent === 'success' && Boolean(msg.text);
            const isExpandable = Boolean(
              msg.text
              && (
                isSystemCollapsed
                || isSuccessCollapsed
                || (msg.isComplete && msg.agent !== 'system' && msg.agent !== 'success')
              ),
            );
            const isExpanded = expandedIds.has(msg.id);
            const badgeProps = getAgentBadgeProps(msg.agent, config);
            return (
              <motion.div
                key={msg.id}
                layout
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, ease: "easeOut" }}
                className="flex items-start space-x-3"
              >
                <span className="text-[#555] opacity-50 flex-shrink-0 pt-0.5">
                  {msg.timestamp.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>

                <div className="flex flex-col space-y-1 flex-1">
                  {/* ── badge row ──────────────────────────────────── */}
                  <div className="flex items-center gap-2 flex-wrap">
                      <span
                      className={`${badgeProps.className} px-2 py-0.5 text-[9px] font-black uppercase tracking-widest rounded flex items-center gap-1.5 min-w-[70px] justify-center relative overflow-hidden`}
                      style={badgeProps.style}
                    >
                      {getAgentName(msg.agent)}
                      {isProcessing && (
                        <>
                          <Loader2 size={9} className="animate-spin opacity-80 shrink-0" />
                          <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/40 to-transparent -translate-x-full animate-[shimmer_2s_infinite]" />
                        </>
                      )}
                    </span>

                    {msg.lobstertrap && (
                      <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-success-green/10 border border-success-green/30 text-success-green text-[8px] font-black uppercase tracking-widest">
                        <ShieldCheck size={8} />
                        Lobstertrap
                      </span>
                    )}

                    {/* "Working ..." lives INLINE beside the badge while processing */}
                    <AnimatePresence mode="wait">
                      {isProcessing && (
                        <motion.span
                          key="working"
                          initial={{ opacity: 0, x: -6 }}
                          animate={{ opacity: 1, x: 0 }}
                          exit={{ opacity: 0, x: -6 }}
                          transition={{ duration: 0.2 }}
                        >
                          <LoopTypewriter
                            className="text-neon-cyan text-[10px] tracking-widest"
                          />
                        </motion.span>
                      )}
                    </AnimatePresence>

                    {!isProcessing && isExpandable && (
                      <button
                        type="button"
                        onClick={() => {
                          setExpandedIds((currentState) => {
                            const next = new Set(currentState);
                            if (next.has(msg.id)) next.delete(msg.id);
                            else next.add(msg.id);
                            return next;
                          });
                        }}
                        className={`flex items-center gap-1 rounded px-2 py-0.5 text-[9px] font-black uppercase tracking-widest transition-all ${getCollapsedStyles(msg)}`}
                      >
                        <ChevronRight
                          size={11}
                          className={`transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`}
                        />
                        {getCollapsedLabel(msg)}
                      </button>
                    )}
                  </div>

                  {/* ── output text — hidden for completed agent tasks until expanded ─ */}
                  <AnimatePresence>
                    {!isProcessing && (!isExpandable || isExpanded) && (
                      <motion.div
                        key="output"
                        initial={{ opacity: 0, y: 3 }}
                        animate={{ opacity: 1, y: 0 }}
                        className={`pl-1 border-l break-words ${getMessageStyles(msg.agent)}`}
                      >
                        <div className="whitespace-pre-wrap">
                          <Typewriter text={msg.text} isFinished={msg.isComplete} />
                        </div>
                        {msg.citations && msg.citations.length > 0 && (
                          <div className="mt-3 space-y-2 rounded-lg border border-neon-cyan/20 bg-neon-cyan/5 p-3">
                            <div className="text-[8px] font-black uppercase tracking-[0.25em] text-neon-cyan">
                              Evidence + Clause Citations
                            </div>
                            <div className="space-y-2">
                              {msg.citations.map((citation) => (
                                <div key={`${citation.label}-${citation.excerpt.slice(0, 24)}`} className="rounded border border-white/10 bg-black/30 p-2">
                                  <div className="text-[8px] font-black uppercase tracking-widest text-white/55">
                                    {citation.label}
                                  </div>
                                  <div className="mt-1 text-[10px] leading-relaxed text-white/78 whitespace-pre-wrap">
                                    {citation.excerpt}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </motion.div>
            );
          })}
        </div>
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
