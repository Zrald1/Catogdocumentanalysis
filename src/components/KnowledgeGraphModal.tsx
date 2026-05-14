import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Network, Search, Database, FileText, ChevronRight, Activity, Globe, AlertTriangle, ShieldCheck } from 'lucide-react';
import { AppConfig, KnowledgeGraphData, KnowledgeGraphLink, KnowledgeGraphNode } from '../types';
import { isKnowledgeGraphConfigured, queryKnowledgeGraph } from '../services/knowledgeGraph';

interface KnowledgeGraphModalProps {
  isOpen: boolean;
  onClose: () => void;
  config: AppConfig;
}

const getNodeRadius = (node: KnowledgeGraphNode) => {
  if (node.kind === 'knowledge-base') {
    return 40;
  }
  if (node.kind === 'document') {
    return 24;
  }
  return 18;
};

const buildNodePositions = (nodes: KnowledgeGraphNode[]) => {
  const positions = new Map<string, { x: number; y: number }>();
  const rootNodes = nodes.filter((node) => node.kind === 'knowledge-base');
  const documentNodes = nodes.filter((node) => node.kind === 'document');
  const conceptNodes = nodes.filter((node) => node.kind !== 'knowledge-base' && node.kind !== 'document');

  rootNodes.forEach((node, index) => {
    positions.set(node.id, {
      x: 400 + index * 10,
      y: 300,
    });
  });

  documentNodes.forEach((node, index) => {
    const angle = (index / Math.max(documentNodes.length, 1)) * Math.PI * 2;
    positions.set(node.id, {
      x: 400 + Math.cos(angle) * 170,
      y: 300 + Math.sin(angle) * 150,
    });
  });

  conceptNodes.forEach((node, index) => {
    const angle = (index / Math.max(conceptNodes.length, 1)) * Math.PI * 2;
    positions.set(node.id, {
      x: 400 + Math.cos(angle) * 300,
      y: 300 + Math.sin(angle) * 230,
    });
  });

  return positions;
};

export default function KnowledgeGraphModal({ isOpen, onClose, config }: KnowledgeGraphModalProps) {
  const [selectedKBId, setSelectedKBId] = useState(config.selectedKBIds[0] || config.knowledgeBases[0]?.id);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedElement, setSelectedElement] = useState<{ type: 'node' | 'link'; id: string } | null>(null);
  const [graphData, setGraphData] = useState<KnowledgeGraphData | null>(null);
  const [manualNodePositions, setManualNodePositions] = useState<Map<string, { x: number; y: number }>>(new Map());
  const [graphState, setGraphState] = useState<{ status: 'idle' | 'loading' | 'error'; message: string }>({
    status: 'idle',
    message: '',
  });
  const [dragState, setDragState] = useState<{ id: string; offsetX: number; offsetY: number } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const didDragRef = useRef(false);

  useEffect(() => {
    if (!selectedKBId) {
      setSelectedKBId(config.selectedKBIds[0] || config.knowledgeBases[0]?.id);
    }
  }, [config, selectedKBId]);

  const currentKB = config.knowledgeBases.find((kb) => kb.id === selectedKBId) || config.knowledgeBases[0];

  useEffect(() => {
    if (!isOpen || !currentKB) {
      return;
    }

    if (!isKnowledgeGraphConfigured(currentKB)) {
      setGraphData(null);
      setGraphState({
        status: 'error',
        message: 'Configure FalkorDB for this knowledge base to view the live intelligence graph.',
      });
      return;
    }

    let isCancelled = false;
    setSelectedElement(null);
    setGraphState({
      status: 'loading',
      message: 'Loading the live knowledge-base graph from FalkorDB...',
    });

    void queryKnowledgeGraph(currentKB, 'knowledge-base')
      .then((data) => {
        if (isCancelled) {
          return;
        }

        setGraphData(data);
        setGraphState({
          status: 'idle',
          message: '',
        });
      })
      .catch((error) => {
        if (isCancelled) {
          return;
        }

        setGraphData(null);
        setGraphState({
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      isCancelled = true;
    };
  }, [currentKB, isOpen]);

  const filteredNodes = useMemo(() => {
    const nodes = graphData?.nodes || [];
    if (!searchTerm.trim()) {
      return nodes;
    }

    return nodes.filter((node) =>
      `${node.label} ${node.kind} ${node.description || ''}`.toLowerCase().includes(searchTerm.toLowerCase()),
    );
  }, [graphData, searchTerm]);

  const visibleNodeIds = useMemo(() => new Set(filteredNodes.map((node) => node.id)), [filteredNodes]);

  const visibleLinks = useMemo(() => {
    const links = graphData?.links || [];
    if (!searchTerm.trim()) {
      return links;
    }

    return links.filter((link) => visibleNodeIds.has(link.source) && visibleNodeIds.has(link.target));
  }, [graphData, searchTerm, visibleNodeIds]);

  const nodePositions = useMemo(() => {
    const basePositions = buildNodePositions(graphData?.nodes || []);
    manualNodePositions.forEach((position, id) => {
      if (basePositions.has(id)) {
        basePositions.set(id, position);
      }
    });
    return basePositions;
  }, [graphData, manualNodePositions]);

  useEffect(() => {
    const basePositions = buildNodePositions(graphData?.nodes || []);
    setManualNodePositions((currentPositions) => {
      const nextPositions = new Map<string, { x: number; y: number }>();
      basePositions.forEach((position, id) => {
        nextPositions.set(id, currentPositions.get(id) || position);
      });
      return nextPositions;
    });
  }, [graphData]);

  const getSvgPoint = useCallback((clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) {
      return null;
    }

    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return null;
    }

    return {
      x: ((clientX - rect.left) / rect.width) * 800,
      y: ((clientY - rect.top) / rect.height) * 600,
    };
  }, []);

  const handleNodePointerDown = useCallback((event: React.PointerEvent<SVGGElement>, nodeId: string) => {
    event.stopPropagation();
    const point = getSvgPoint(event.clientX, event.clientY);
    const currentPosition = nodePositions.get(nodeId);
    if (!point || !currentPosition) {
      return;
    }

    didDragRef.current = false;
    setDragState({
      id: nodeId,
      offsetX: point.x - currentPosition.x,
      offsetY: point.y - currentPosition.y,
    });
  }, [getSvgPoint, nodePositions]);

  const handleSvgPointerMove = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    if (!dragState) {
      return;
    }

    const point = getSvgPoint(event.clientX, event.clientY);
    if (!point) {
      return;
    }

    didDragRef.current = true;
    setManualNodePositions((currentPositions) => {
      const nextPositions = new Map(currentPositions);
      nextPositions.set(dragState.id, {
        x: Math.min(760, Math.max(40, point.x - dragState.offsetX)),
        y: Math.min(560, Math.max(40, point.y - dragState.offsetY)),
      });
      return nextPositions;
    });
  }, [dragState, getSvgPoint]);

  const stopDragging = useCallback(() => {
    setDragState(null);
  }, []);

  const activeElementData = useMemo(() => {
    if (!selectedElement) {
      return null;
    }

    if (selectedElement.type === 'node') {
      return graphData?.nodes.find((node) => node.id === selectedElement.id) || null;
    }

    return graphData?.links.find((link) => link.id === selectedElement.id) || null;
  }, [graphData, selectedElement]);

  return (
    <AnimatePresence>
      {isOpen && currentKB && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-black/80 backdrop-blur-sm"
          />

          <motion.div
            initial={{ scale: 0.94, opacity: 0, y: 20 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.94, opacity: 0, y: 20 }}
            className="relative w-full max-w-6xl h-[85vh] bg-panel-bg border border-white/10 rounded-xl shadow-2xl flex overflow-hidden"
          >
            <div className="w-80 border-r border-white/10 flex flex-col bg-black/20">
              <div className="p-6 border-b border-white/10">
                <div className="flex items-center space-x-3 mb-6">
                  <div className="p-2 bg-neon-cyan/20 border border-neon-cyan/30 rounded-lg">
                    <Network size={20} className="text-neon-cyan" />
                  </div>
                  <div>
                    <h2 className="text-sm font-black uppercase tracking-widest text-white">Knowledge Graph</h2>
                    <p className="text-[10px] text-white/40 uppercase font-bold tracking-tight">FalkorDB Intelligence View</p>
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="space-y-2">
                    <label className="text-[9px] font-black text-white/30 uppercase tracking-widest flex items-center gap-1.5">
                      <Database size={10} /> Active Knowledge Base
                    </label>
                    <div className="space-y-1">
                      {config.knowledgeBases.map((kb) => (
                        <button
                          key={kb.id}
                          onClick={() => setSelectedKBId(kb.id)}
                          className={`w-full flex items-center justify-between p-2.5 rounded transition-all group ${
                            selectedKBId === kb.id ? 'bg-neon-cyan/10 border border-neon-cyan/20' : 'hover:bg-white/5 border border-transparent'
                          }`}
                        >
                          <div className="flex items-center space-x-3">
                            <div className={`w-1.5 h-1.5 rounded-full ${selectedKBId === kb.id ? 'bg-neon-cyan animate-pulse' : 'bg-white/20'}`} />
                            <span className={`text-[10px] font-bold uppercase tracking-tight ${selectedKBId === kb.id ? 'text-neon-cyan' : 'text-white/40 group-hover:text-white/60'}`}>
                              {kb.name}
                            </span>
                          </div>
                          <ChevronRight size={12} className={selectedKBId === kb.id ? 'text-neon-cyan' : 'text-white/10'} />
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30" size={12} />
                    <input
                      type="text"
                      placeholder="Search graph nodes..."
                      value={searchTerm}
                      onChange={(event) => setSearchTerm(event.target.value)}
                      className="w-full bg-black/40 border border-white/10 rounded-md pl-8 pr-4 py-2 text-[10px] text-white outline-none focus:border-neon-cyan transition-all"
                    />
                  </div>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {graphState.status === 'error' ? (
                  <div className="p-4 rounded-lg border border-error-red/20 bg-error-red/10 text-error-red text-[10px] font-bold leading-relaxed">
                    {graphState.message}
                  </div>
                ) : graphState.status === 'loading' ? (
                  <div className="p-4 rounded-lg border border-neon-cyan/20 bg-neon-cyan/10 text-neon-cyan text-[10px] font-bold">
                    {graphState.message}
                  </div>
                ) : filteredNodes.length === 0 ? (
                  <div className="p-4 rounded-lg border border-white/10 bg-white/[0.03] text-white/40 text-[10px] font-bold leading-relaxed">
                    No indexed graph nodes were found for this knowledge base yet.
                  </div>
                ) : (
                  <div className="space-y-2">
                    <span className="text-[8px] font-black uppercase text-white/20 tracking-widest pl-2">Indexed Nodes</span>
                    <div className="space-y-1">
                      {filteredNodes.map((node) => (
                        <button
                          key={node.id}
                          onClick={() => setSelectedElement({ type: 'node', id: node.id })}
                          className={`w-full flex items-center space-x-3 p-2 rounded transition-colors group ${selectedElement?.id === node.id ? 'bg-white/10' : 'hover:bg-white/5'}`}
                        >
                          {node.kind === 'document' ? <FileText size={12} className="text-neon-pink" /> : <Activity size={12} className="text-neon-cyan" />}
                          <div className="flex flex-col items-start min-w-0">
                            <span className="text-[10px] text-white/70 group-hover:text-white transition-colors truncate w-full">{node.label}</span>
                            <span className="text-[8px] uppercase tracking-widest text-white/25">{node.kind}</span>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="p-4 border-t border-white/10 bg-black/40">
                <div className="flex items-center justify-between text-[8px] font-black uppercase tracking-widest text-white/20">
                  <span>Live Graph</span>
                  <span className="text-success-green">{graphData ? `${graphData.nodes.length}N / ${graphData.links.length}E` : 'EMPTY'}</span>
                </div>
              </div>
            </div>

            <div className="flex-1 relative bg-[radial-gradient(circle_at_center,rgba(0,255,255,0.02)_0%,transparent_70%)] overflow-hidden">
              <div className="absolute inset-0 pointer-events-none opacity-20">
                <div className="absolute inset-0 grid-bg" />
                <div className="absolute inset-0 terminal-scanline" />
              </div>

              <div className="absolute top-6 left-6 right-6 flex items-center justify-between z-10">
                <div className="flex items-center space-x-4">
                  <div className="flex items-center space-x-2 px-3 py-1 bg-black/60 border border-white/10 rounded-full">
                    <Globe size={10} className="text-neon-cyan" />
                    <span className="text-[10px] font-black uppercase tracking-widest text-[#F2F2F2]">
                      Graph: {currentKB.graphName || 'UNSET'}
                    </span>
                  </div>
                  <div className="flex items-center space-x-2 px-3 py-1 bg-black/60 border border-white/10 rounded-full">
                    <Database size={10} className="text-neon-pink" />
                    <span className="text-[10px] font-black uppercase tracking-widest text-[#F2F2F2]">
                      Files: {graphData?.nodes.filter((node) => node.kind === 'document').length || 0}
                    </span>
                  </div>
                  <div className="flex items-center space-x-2 px-3 py-1 bg-black/60 border border-success-green/20 rounded-full">
                    <ShieldCheck size={10} className="text-success-green" />
                    <span className="text-[10px] font-black uppercase tracking-widest text-success-green/80">
                      LobsterTrap: Monitoring
                    </span>
                  </div>
                </div>
                <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-full transition-all group">
                  <X size={20} className="text-white/40 group-hover:text-white" />
                </button>
              </div>

              <div className="w-full h-full flex items-center justify-center p-20 overflow-visible">
                {graphState.status === 'error' ? (
                  <div className="max-w-xl text-center space-y-4">
                    <AlertTriangle size={28} className="mx-auto text-error-red" />
                    <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-error-red">Graph unavailable</p>
                    <p className="text-[12px] text-white/55 leading-relaxed">{graphState.message}</p>
                  </div>
                ) : (
                  <svg
                    ref={svgRef}
                    className="w-full h-full overflow-visible"
                    viewBox="0 0 800 600"
                    onPointerMove={handleSvgPointerMove}
                    onPointerUp={stopDragging}
                    onPointerLeave={stopDragging}
                  >
                    <defs>
                      <marker id="graph-arrow" viewBox="0 0 10 10" refX="18" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                        <path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(255,255,255,0.15)" />
                      </marker>
                      <linearGradient id="graph-link-flow" x1="0%" y1="0%" x2="100%" y2="0%">
                        <stop offset="0%" stopColor="rgba(0,255,255,0.05)" />
                        <stop offset="35%" stopColor="rgba(0,255,255,0.95)" />
                        <stop offset="65%" stopColor="rgba(255,45,149,0.85)" />
                        <stop offset="100%" stopColor="rgba(0,255,255,0.05)" />
                      </linearGradient>
                      <filter id="graph-glow">
                        <feGaussianBlur stdDeviation="2.5" result="coloredBlur" />
                        <feMerge>
                          <feMergeNode in="coloredBlur" />
                          <feMergeNode in="SourceGraphic" />
                        </feMerge>
                      </filter>
                    </defs>

                    {visibleLinks.map((link, index) => {
                      const source = graphData?.nodes.find((node) => node.id === link.source);
                      const target = graphData?.nodes.find((node) => node.id === link.target);
                      if (!source || !target) {
                        return null;
                      }

                      const sourcePos = nodePositions.get(source.id);
                      const targetPos = nodePositions.get(target.id);
                      if (!sourcePos || !targetPos) {
                        return null;
                      }

                      return (
                        <g
                          key={link.id}
                          className="cursor-pointer"
                          onClick={(event) => {
                            event.stopPropagation();
                            setSelectedElement({ type: 'link', id: link.id });
                          }}
                        >
                          <motion.line
                            initial={{ pathLength: 0, opacity: 0 }}
                            animate={{ pathLength: 1, opacity: 1 }}
                            transition={{ duration: 0.8, delay: index * 0.04 }}
                            x1={sourcePos.x}
                            y1={sourcePos.y}
                            x2={targetPos.x}
                            y2={targetPos.y}
                            stroke={selectedElement?.id === link.id ? 'rgba(0,255,255,0.9)' : 'rgba(255,255,255,0.18)'}
                            strokeWidth={selectedElement?.id === link.id ? 2.2 : 1.2}
                            markerEnd="url(#graph-arrow)"
                          />
                          <motion.line
                            x1={sourcePos.x}
                            y1={sourcePos.y}
                            x2={targetPos.x}
                            y2={targetPos.y}
                            stroke="url(#graph-link-flow)"
                            strokeWidth={selectedElement?.id === link.id ? 2.8 : 2}
                            strokeLinecap="round"
                            strokeDasharray="18 20"
                            animate={{ strokeDashoffset: [0, -76] }}
                            transition={{ duration: 2.2, ease: 'linear', repeat: Infinity }}
                            opacity={selectedElement?.id === link.id ? 1 : 0.75}
                          />
                          <text
                            x={(sourcePos.x + targetPos.x) / 2}
                            y={(sourcePos.y + targetPos.y) / 2 - 8}
                            className={`text-[7px] font-black uppercase tracking-widest ${selectedElement?.id === link.id ? 'fill-neon-cyan' : 'fill-white/35'}`}
                            textAnchor="middle"
                          >
                            {link.label}
                          </text>
                        </g>
                      );
                    })}

                    {(searchTerm.trim() ? filteredNodes : graphData?.nodes || []).map((node, index) => {
                      const position = nodePositions.get(node.id);
                      if (!position) {
                        return null;
                      }

                      const isSelected = selectedElement?.id === node.id;
                      const isDocument = node.kind === 'document';
                      const isRoot = node.kind === 'knowledge-base';

                      return (
                        <motion.g
                          key={node.id}
                          initial={{ scale: 0.7, opacity: 0 }}
                          animate={{ scale: 1, opacity: 1 }}
                          transition={{ delay: index * 0.03 }}
                          onPointerDown={(event) => handleNodePointerDown(event, node.id)}
                          onClick={(event) => {
                            event.stopPropagation();
                            if (didDragRef.current) {
                              didDragRef.current = false;
                              return;
                            }
                            setSelectedElement({ type: 'node', id: node.id });
                          }}
                          className={dragState?.id === node.id ? 'cursor-grabbing' : 'cursor-grab'}
                        >
                          <circle
                            cx={position.x}
                            cy={position.y}
                            r={getNodeRadius(node)}
                            fill={isRoot ? 'rgba(0,255,255,0.18)' : isDocument ? 'rgba(255,45,149,0.18)' : 'rgba(10,10,12,0.88)'}
                            stroke={isSelected ? '#00FFFF' : isRoot ? '#00FFFF' : isDocument ? '#FF2D95' : 'rgba(255,255,255,0.25)'}
                            strokeWidth={isSelected ? 3 : 2}
                            filter={isSelected || isRoot ? 'url(#graph-glow)' : 'none'}
                          />
                          <motion.circle
                            cx={position.x}
                            cy={position.y}
                            r={getNodeRadius(node) + 7}
                            fill="transparent"
                            stroke={isDocument ? 'rgba(255,45,149,0.45)' : 'rgba(0,255,255,0.45)'}
                            strokeWidth={1.2}
                            animate={{ scale: [1, 1.08, 1], opacity: [0.35, 0.8, 0.35] }}
                            transition={{ duration: 2.6, repeat: Infinity, ease: 'easeInOut' }}
                          />
                          <text
                            x={position.x}
                            y={position.y + getNodeRadius(node) + 16}
                            className={`text-[9px] font-black uppercase tracking-widest ${isSelected ? 'fill-neon-cyan' : 'fill-white'}`}
                            textAnchor="middle"
                          >
                            {node.label}
                          </text>
                        </motion.g>
                      );
                    })}
                  </svg>
                )}
              </div>

              <AnimatePresence>
                {activeElementData && (
                  <motion.div
                    initial={{ x: 300, opacity: 0 }}
                    animate={{ x: 0, opacity: 1 }}
                    exit={{ x: 300, opacity: 0 }}
                    className="absolute top-0 right-0 bottom-0 w-80 bg-black/80 backdrop-blur-md border-l border-white/10 z-20 flex flex-col"
                  >
                    <div className="p-6 border-b border-white/10 flex items-center justify-between">
                      <div>
                        <h3 className="text-[10px] font-black uppercase tracking-widest text-white">Graph Detail</h3>
                        <p className="text-[8px] text-white/40 uppercase font-black tracking-tight">
                          {selectedElement?.type === 'node'
                            ? (activeElementData as KnowledgeGraphNode).label
                            : (activeElementData as KnowledgeGraphLink).label}
                        </p>
                      </div>
                      <button onClick={() => setSelectedElement(null)} className="p-1 hover:bg-white/10 rounded-full">
                        <X size={14} className="text-white/40" />
                      </button>
                    </div>

                    <div className="flex-1 overflow-y-auto p-6 space-y-4">
                      {'kind' in activeElementData ? (
                        <>
                          <div className="space-y-2">
                            <span className="text-[8px] font-black uppercase text-neon-cyan tracking-widest">Node Type</span>
                            <div className="p-3 bg-white/[0.03] rounded text-[11px] text-white/70 uppercase">{activeElementData.kind}</div>
                          </div>
                          <div className="space-y-2">
                            <span className="text-[8px] font-black uppercase text-neon-cyan tracking-widest">Description</span>
                            <div className="p-4 bg-white/[0.03] border border-white/5 rounded text-[11px] leading-relaxed text-white/70 italic">
                              {activeElementData.description || 'No description stored for this node.'}
                            </div>
                          </div>
                          <div className="space-y-2">
                            <span className="text-[8px] font-black uppercase text-neon-cyan tracking-widest">Source File</span>
                            <div className="p-3 bg-white/[0.03] rounded text-[11px] text-white/70">{activeElementData.sourceFile || 'Knowledge-base root node'}</div>
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="space-y-2">
                            <span className="text-[8px] font-black uppercase text-neon-cyan tracking-widest">Relationship</span>
                            <div className="p-3 bg-white/[0.03] rounded text-[11px] text-white/70 uppercase">{activeElementData.label}</div>
                          </div>
                          <div className="space-y-2">
                            <span className="text-[8px] font-black uppercase text-neon-cyan tracking-widest">Description</span>
                            <div className="p-4 bg-white/[0.03] border border-white/5 rounded text-[11px] leading-relaxed text-white/70 italic">
                              {activeElementData.description || 'No relationship description stored.'}
                            </div>
                          </div>
                          <div className="space-y-2">
                            <span className="text-[8px] font-black uppercase text-neon-cyan tracking-widest">Evidence</span>
                            <div className="p-4 bg-white/[0.03] border border-white/5 rounded text-[11px] leading-relaxed text-white/70 italic">
                              {activeElementData.evidence || 'No evidence excerpt stored.'}
                            </div>
                          </div>
                        </>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
