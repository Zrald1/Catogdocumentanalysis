/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, FileCheck, Info, AlertTriangle, GitMerge, FileText, Activity } from 'lucide-react';
import { DocumentAnalysis } from '../types';
import ReportFormatModal from './ReportFormatModal';
import { generateTxtReport, generatePdfReport, generateDocxReport } from '../services/reportGenerator';
import { buildMermaidChart, renderMermaidSvg } from '../lib/mermaidChart';

interface DocumentModalProps {
  doc: DocumentAnalysis | null;
  onClose: () => void;
  onApplyFixes: (doc: DocumentAnalysis) => void;
}

const MermaidView = ({ chart }: { chart: string }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    const renderChart = async () => {
      try {
        if (chart) {
          setError(null);
          setZoom(1);
          setPan({ x: 0, y: 0 });
          setSvg(await renderMermaidSvg(chart));
        }
      } catch (err) {
        console.error("Mermaid Render Error:", err);
        setSvg('');
        setError(err instanceof Error ? err.message : 'Mermaid render failed.');
      }
    };

    renderChart();
  }, [chart]);

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    setZoom((currentZoom) => {
      const nextZoom = currentZoom + (event.deltaY < 0 ? 0.12 : -0.12);
      return Math.min(2.5, Math.max(0.6, Number(nextZoom.toFixed(2))));
    });
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: pan.x,
      originY: pan.y,
    };
    setIsDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    setPan({
      x: dragState.originX + (event.clientX - dragState.startX),
      y: dragState.originY + (event.clientY - dragState.startY),
    });
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragStateRef.current?.pointerId === event.pointerId) {
      dragStateRef.current = null;
      setIsDragging(false);
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div className="flex flex-col min-h-[400px] p-5 bg-black/40 rounded-xl border border-white/5 overflow-hidden">
      {error ? (
        <div className="w-full max-w-2xl rounded-lg border border-error-red/20 bg-error-red/10 p-5 text-left">
          <div className="text-[10px] font-black uppercase tracking-widest text-error-red">Mermaid unavailable</div>
          <div className="mt-2 text-[12px] leading-relaxed text-white/70">{error}</div>
        </div>
      ) : (
        <>
          <div className="mb-3 flex items-center justify-between px-1 text-[11px] font-bold uppercase tracking-widest text-white/70">
            <span>Wheel zoom + drag pan</span>
            <span className="text-white">{Math.round(zoom * 100)}%</span>
          </div>
          <div
            onWheel={handleWheel}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            className={`flex-1 overflow-auto rounded-lg border border-white/5 bg-black/20 select-none ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
            style={{ touchAction: 'none' }}
          >
            <div
              className="flex min-h-full min-w-full items-start justify-center p-6"
              style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: 'top center' }}
            >
              <div
                ref={containerRef}
                dangerouslySetInnerHTML={{ __html: svg }}
                className="w-full flex justify-center [&>svg]:max-w-none [&>svg]:h-auto"
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default function DocumentModal({ doc, onClose, onApplyFixes }: DocumentModalProps) {
  const [isGenerating, setIsGenerating] = useState(false);
  const [activeTab, setActiveTab] = useState<'corrections' | 'mermaid'>('corrections');
  const [isFormatModalOpen, setIsFormatModalOpen] = useState(false);

  if (!doc) return null;

  const mermaidChart = buildMermaidChart(doc);
  const graphSummary = doc.graphIndex
    ? `${doc.graphIndex.nodeCount} nodes • ${doc.graphIndex.edgeCount} edges`
    : doc.graph
      ? `${doc.graph.nodes.length} nodes • ${doc.graph.links.length} edges`
      : 'No graph indexed';
  const graphSummaryBadgeClass = doc.graphIndex?.storageMode === 'indexed'
    ? 'border-success-green/20 bg-success-green/10 text-success-green'
    : 'border-neon-cyan/20 bg-neon-cyan/10 text-neon-cyan';
  const highSeverityFindings = doc.findings.filter((finding) => finding.severity === 'high').length;
  const mediumSeverityFindings = doc.findings.filter((finding) => finding.severity === 'medium').length;
  const securityStatusLabel = highSeverityFindings > 0
    ? 'Critical'
    : mediumSeverityFindings > 0
      ? 'Review'
      : doc.findings.length > 0
        ? 'Stable'
        : 'Clear';
  const securityStatusTone = highSeverityFindings > 0
    ? 'border-error-red/20 bg-[#1A1214] text-error-red'
    : mediumSeverityFindings > 0
      ? 'border-neon-yellow/20 bg-[#1A170F] text-neon-yellow'
      : 'border-success-green/20 bg-[#101916] text-success-green';
  const securityStatusMessage = highSeverityFindings > 0
    ? 'High-severity findings were detected and need analyst review.'
    : mediumSeverityFindings > 0
      ? 'Moderate findings were detected. Review is recommended before applying changes.'
      : doc.findings.length > 0
        ? 'Only lower-severity findings are currently present.'
        : 'No findings were detected for this document.';
  const automatedFixLabel = doc.corrections.length > 0 ? 'Ready' : 'None';
  const automatedFixMessage = doc.corrections.length > 0
    ? 'Ready-to-apply fixes were generated from the analysis output.'
    : 'No automated fixes were generated for this document.';
  const obligationLabel = doc.obligations.length > 0 ? 'Tracked' : 'Clear';
  const obligationMessage = doc.obligations.length > 0
    ? 'Operational obligations were extracted for follow-up and ownership.'
    : 'No follow-up obligations were extracted from this document.';

  const handleFormatSelect = async (format: 'txt' | 'pdf' | 'docx') => {
      setIsFormatModalOpen(false);
      setIsGenerating(true);
    
    try {
      if (format === 'txt') {
        await generateTxtReport(doc);
      } else if (format === 'pdf') {
        await generatePdfReport(doc);
      } else if (format === 'docx') {
        await generateDocxReport(doc);
      }
    } catch (err) {
      console.error("Report generation failed:", err);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleGenerateReport = () => {
    setIsFormatModalOpen(true);
  };

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/90 backdrop-blur-sm">
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          className="bg-[#0D0D0F] w-full max-w-4xl h-[90vh] rounded-lg border border-border-grey shadow-[0_0_50px_rgba(0,0,0,1)] overflow-hidden flex flex-col"
        >
          {/* Header */}
          <div className="px-6 py-4 border-b border-border-grey flex items-center justify-between bg-[#161618]">
            <div className="flex items-center space-x-4">
              <div className="w-10 h-10 rounded bg-neon-pink/10 flex items-center justify-center text-neon-pink border border-neon-pink/20">
                <FileCheck size={20} />
              </div>
                <div>
                  <h2 className="text-lg font-bold text-[#F2F2F2] uppercase tracking-tight">{doc.fileName}</h2>
                  <div className="flex items-center space-x-2">
                    <span className="text-[#666] text-[10px] font-mono uppercase tracking-widest">Correction Sync Active</span>
                  </div>
                </div>
              </div>
            <button
              onClick={onClose}
              className="p-2 hover:bg-white/5 rounded-md transition-colors text-[#666] hover:text-white"
            >
              <X size={20} />
            </button>
          </div>

          <div className="flex-1 overflow-hidden flex flex-col">
            {/* Tabs Navigation */}
            <div className="px-8 pt-6 border-b border-white/5 flex items-center space-x-8">
              <button 
                onClick={() => setActiveTab('corrections')}
                className={`pb-4 text-[10px] font-black uppercase tracking-[0.2em] transition-all relative ${activeTab === 'corrections' ? 'text-neon-cyan' : 'text-white/30 hover:text-white/60'}`}
              >
                <div className="flex items-center gap-2">
                  <FileText size={12} />
                  Findings, Corrections & Obligations
                </div>
                {activeTab === 'corrections' && <motion.div layoutId="modal-tab" className="absolute bottom-0 left-0 right-0 h-0.5 bg-neon-cyan" />}
              </button>
              <button 
                onClick={() => setActiveTab('mermaid')}
                className={`pb-4 text-[10px] font-black uppercase tracking-[0.2em] transition-all relative ${activeTab === 'mermaid' ? 'text-neon-pink' : 'text-white/30 hover:text-white/60'}`}
              >
                <div className="flex items-center gap-2">
                  <GitMerge size={12} />
                  Mermaid Diagram
                </div>
                {activeTab === 'mermaid' && <motion.div layoutId="modal-tab" className="absolute bottom-0 left-0 right-0 h-0.5 bg-neon-pink" />}
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-8 custom-scrollbar">
              <AnimatePresence mode="wait">
                {activeTab === 'corrections' && (
                  <motion.div 
                    key="corrections"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="space-y-12"
                  >
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-5">
                      {/* Findings Card */}
                      <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-[#151518] px-5 py-5 shadow-[0_12px_30px_rgba(0,0,0,0.28)]">
                        <div className="mb-5 flex items-start justify-between">
                          <div className="text-[10px] font-semibold uppercase tracking-[0.24em] text-white/45">Findings</div>
                          <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-white/55">
                            <Info size={18} />
                          </div>
                        </div>
                        <div className="flex items-end gap-3">
                          <div className="text-4xl font-semibold text-white tabular-nums">{doc.findings.length}</div>
                          <div className="pb-1 text-[11px] font-medium uppercase tracking-[0.18em] text-white/55">Active Alerts</div>
                        </div>
                        <div className="mt-4 h-px w-full bg-white/8" />
                        <div className="mt-3 text-[12px] leading-relaxed text-white/60">Detected review items that need analyst attention.</div>
                      </div>

                      {/* Security Status Card */}
                      <div className={`relative overflow-hidden rounded-2xl border px-5 py-5 shadow-[0_12px_30px_rgba(0,0,0,0.28)] ${securityStatusTone}`}>
                        <div className="mb-5 flex items-start justify-between">
                          <div className="text-[10px] font-semibold uppercase tracking-[0.24em]">Security Status</div>
                          <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-current/20 bg-current/10">
                            <AlertTriangle size={18} />
                          </div>
                        </div>
                        <div className="text-3xl font-semibold uppercase tracking-[0.08em]">
                          {securityStatusLabel}
                        </div>
                        <div className="mt-4 h-px w-full bg-current/12" />
                        <div className="mt-3 text-[12px] leading-relaxed text-white/65">{securityStatusMessage}</div>
                      </div>

                      {/* Automated Fixes Card */}
                      <div className="relative overflow-hidden rounded-2xl border border-success-green/20 bg-[#101916] px-5 py-5 shadow-[0_12px_30px_rgba(0,0,0,0.28)]">
                        <div className="mb-5 flex items-start justify-between">
                          <div className="text-[10px] font-semibold uppercase tracking-[0.24em] text-success-green/80">Automated Fixes</div>
                          <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-success-green/20 bg-success-green/10 text-success-green/80">
                            <FileCheck size={18} />
                          </div>
                        </div>
                        <div className="flex items-end gap-3">
                            <div className="text-4xl font-semibold text-success-green tabular-nums">{doc.corrections.length}</div>
                            <div className="pb-1 text-[11px] font-medium uppercase tracking-[0.18em] text-success-green/70">{automatedFixLabel}</div>
                          </div>
                        <div className="mt-4 h-px w-full bg-success-green/12" />
                        <div className="mt-3 text-[12px] leading-relaxed text-white/65">{automatedFixMessage}</div>
                      </div>

                      {/* Obligation Register Card */}
                      <div className="relative overflow-hidden rounded-2xl border border-neon-cyan/20 bg-[#10181B] px-5 py-5 shadow-[0_12px_30px_rgba(0,0,0,0.28)]">
                        <div className="mb-5 flex items-start justify-between">
                          <div className="text-[10px] font-semibold uppercase tracking-[0.24em] text-neon-cyan/80">Obligations</div>
                          <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-neon-cyan/20 bg-neon-cyan/10 text-neon-cyan/80">
                            <Activity size={18} />
                          </div>
                        </div>
                        <div className="flex items-end gap-3">
                            <div className="text-4xl font-semibold text-neon-cyan tabular-nums">{doc.obligations.length}</div>
                            <div className="pb-1 text-[11px] font-medium uppercase tracking-[0.18em] text-neon-cyan/70">{obligationLabel}</div>
                          </div>
                        <div className="mt-4 h-px w-full bg-neon-cyan/12" />
                        <div className="mt-3 text-[12px] leading-relaxed text-white/65">{obligationMessage}</div>
                      </div>
                    </div>

                    <div className="space-y-6">
                      <div className="space-y-3">
                        <div className="flex items-center space-x-3 mb-2">
                          <div className="h-px flex-1 bg-gradient-to-r from-transparent via-white/5 to-transparent" />
                          <div className="px-4 py-1.5 bg-white/[0.03] border border-white/5 text-[9px] uppercase font-black text-white/50 rounded-full tracking-[0.3em] flex items-center gap-2">
                            <div className="w-1 h-1 rounded-full bg-neon-cyan" />
                            Finding Trace Links
                          </div>
                          <div className="h-px flex-1 bg-gradient-to-r from-transparent via-white/5 to-transparent" />
                        </div>
                        {doc.findings.map((finding, index) => (
                          <div key={`finding-${doc.id}-${index}`} className="rounded-lg border border-white/5 bg-[#161618] p-5 space-y-3">
                            <div className="flex items-start justify-between gap-4">
                              <p className="text-[13px] leading-relaxed text-[#F2F2F2]">{finding.message}</p>
                              <span className={`shrink-0 rounded px-2 py-1 text-[9px] font-black uppercase tracking-widest ${
                                finding.severity === 'high'
                                  ? 'bg-error-red/20 text-error-red'
                                  : finding.severity === 'medium'
                                    ? 'bg-neon-yellow/20 text-neon-yellow'
                                    : 'bg-white/10 text-white/60'
                              }`}>
                                {finding.severity}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>

                      <div className="flex items-center space-x-3 mb-6">
                        <div className="h-px flex-1 bg-gradient-to-r from-transparent via-white/5 to-transparent" />
                        <div className="px-4 py-1.5 bg-white/[0.03] border border-white/5 text-[9px] uppercase font-black text-white/50 rounded-full tracking-[0.3em] flex items-center gap-2">
                          <div className="w-1 h-1 rounded-full bg-neon-pink" />
                          Structural Diff Matrix
                        </div>
                        <div className="h-px flex-1 bg-gradient-to-r from-transparent via-white/5 to-transparent" />
                      </div>
                      
                      <div className="space-y-3">
                        {doc.corrections.map((correction, i) => (
                          <motion.div
                            key={`modal-corr-${doc.id}-${i}`}
                            initial={{ opacity: 0, x: -5 }}
                            animate={{ opacity: 1, x: 0 }}
                            transition={{ delay: i * 0.05 }}
                            className="p-6 rounded-lg bg-[#161618] border border-border-grey hover:border-[#444] transition-all group"
                          >
                            <div className="flex items-start space-x-4">
                              {correction.isRequirement ? <Info className="text-success-green" size={16} /> : <AlertTriangle className="text-error-red" size={16} />}
                               <div className="flex-1 space-y-4">
                                 <p className="text-[#888] text-[13px] leading-relaxed font-sans">{correction.reason}</p>
                                  <div className="space-y-1">
                                  {!correction.isRequirement && (
                                    <div className="relative group/line">
                                      <div className="absolute left-0 top-0 bottom-0 w-1 bg-error-red/40" />
                                      <div className="bg-error-red/10 p-3 pl-6 rounded-r border-t border-r border-b border-error-red/20 text-[#F2F2F2]/40 text-[13px] line-through decoration-error-red/60 font-mono leading-relaxed italic">
                                        <span className="absolute left-2.5 top-3.5 text-error-red font-bold text-[10px]">-</span>
                                        {correction.original}
                                      </div>
                                    </div>
                                  )}
                                  <div className="relative group/line">
                                    <div className="absolute left-0 top-0 bottom-0 w-1 bg-success-green" />
                                    <div className="bg-success-green/10 p-3 pl-6 rounded-r border-t border-r border-b border-success-green/20 text-success-green text-[13px] font-mono leading-relaxed font-medium">
                                      <span className="absolute left-2.5 top-3.5 text-success-green font-bold text-[10px]">+</span>
                                      {correction.suggested}
                                    </div>
                                  </div>
                                </div>
                              </div>
                            </div>
                          </motion.div>
                        ))}
                      </div>

                      <div className="flex items-center space-x-3 mb-6">
                        <div className="h-px flex-1 bg-gradient-to-r from-transparent via-white/5 to-transparent" />
                        <div className="px-4 py-1.5 bg-white/[0.03] border border-white/5 text-[9px] uppercase font-black text-white/50 rounded-full tracking-[0.3em] flex items-center gap-2">
                          <div className="w-1 h-1 rounded-full bg-neon-cyan" />
                          Obligation Register
                        </div>
                        <div className="h-px flex-1 bg-gradient-to-r from-transparent via-white/5 to-transparent" />
                      </div>

                      <div className="space-y-3">
                        {doc.obligations.length === 0 ? (
                          <div className="rounded-lg border border-white/5 bg-[#161618] p-5 text-[12px] text-white/45">
                            No explicit obligations were captured for this document.
                          </div>
                        ) : doc.obligations.map((obligation, i) => (
                          <motion.div
                            key={`modal-obligation-${doc.id}-${i}`}
                            initial={{ opacity: 0, x: -5 }}
                            animate={{ opacity: 1, x: 0 }}
                            transition={{ delay: i * 0.05 }}
                            className="p-6 rounded-lg bg-[#161618] border border-neon-cyan/10 hover:border-neon-cyan/30 transition-all"
                          >
                            <div className="flex items-start justify-between gap-4">
                              <div className="space-y-3 flex-1 min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  <p className="text-[15px] leading-relaxed text-[#F2F2F2] font-semibold">{obligation.title}</p>
                                  <span className={`rounded px-2 py-1 text-[9px] font-black uppercase tracking-widest ${
                                    obligation.priority === 'high'
                                      ? 'bg-error-red/20 text-error-red'
                                      : obligation.priority === 'medium'
                                        ? 'bg-neon-yellow/20 text-neon-yellow'
                                        : 'bg-white/10 text-white/60'
                                  }`}>
                                    {obligation.priority}
                                  </span>
                                  <span className={`rounded px-2 py-1 text-[9px] font-black uppercase tracking-widest ${
                                    obligation.status === 'resolved'
                                      ? 'bg-success-green/20 text-success-green'
                                      : obligation.status === 'blocked'
                                        ? 'bg-error-red/20 text-error-red'
                                        : obligation.status === 'in_progress'
                                          ? 'bg-neon-blue/20 text-neon-blue'
                                          : 'bg-white/10 text-white/60'
                                  }`}>
                                    {obligation.status.replace('_', ' ')}
                                  </span>
                                </div>

                                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-[11px]">
                                  <div className="rounded border border-white/5 bg-black/30 px-3 py-2">
                                    <div className="text-white/30 uppercase tracking-widest text-[8px] font-black">Owner</div>
                                    <div className="mt-1 text-white/80">{obligation.owner}</div>
                                  </div>
                                  <div className="rounded border border-white/5 bg-black/30 px-3 py-2">
                                    <div className="text-white/30 uppercase tracking-widest text-[8px] font-black">Due / Trigger</div>
                                    <div className="mt-1 text-white/80">{obligation.dueDate}</div>
                                  </div>
                                  <div className="rounded border border-white/5 bg-black/30 px-3 py-2">
                                    <div className="text-white/30 uppercase tracking-widest text-[8px] font-black">Rationale</div>
                                    <div className="mt-1 text-white/80">{obligation.rationale}</div>
                                  </div>
                                </div>

                                <div className="rounded border border-neon-cyan/10 bg-neon-cyan/5 px-3 py-2">
                                  <div className="text-neon-cyan/70 uppercase tracking-widest text-[8px] font-black">Source Excerpt</div>
                                  <div className="mt-1 text-[12px] leading-relaxed text-white/70">{obligation.sourceExcerpt}</div>
                                </div>

                              </div>
                            </div>
                          </motion.div>
                        ))}
                      </div>
                    </div>
                  </motion.div>
                )}

                {activeTab === 'mermaid' && (
                  <motion.div 
                    key="mermaid"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="h-full flex flex-col space-y-6"
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-sm font-black uppercase text-white tracking-widest">Technical Logic Flow</h3>
                        <p className="text-[10px] text-white/40 uppercase font-bold tracking-tight">Real findings, corrections, and obligation flow</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className={`px-3 py-1 rounded border text-[9px] font-mono ${graphSummaryBadgeClass}`}>
                          {graphSummary}
                        </div>
                        <div className="px-3 py-1 bg-white/5 rounded border border-white/10 text-[9px] font-mono text-white/60">
                          MERMAID_GRAPH_v3
                        </div>
                      </div>
                    </div>
                    <MermaidView chart={mermaidChart} />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>

          {/* Footer */}
          <div className="p-6 border-t border-border-grey bg-[#161618] flex items-center justify-between">
            <div className="flex items-center space-x-2 text-[10px] font-mono text-[#555] uppercase tracking-widest">
              <div className="w-1.5 h-1.5 rounded-full bg-success-green animate-pulse" />
              <span>Corrections ready for export or apply fixes</span>
            </div>
            <div className="flex items-center space-x-4">
              <button 
                onClick={handleGenerateReport}
                disabled={isGenerating}
                className="px-6 py-2 rounded border border-white/10 text-[#F2F2F2] hover:bg-white/5 font-bold uppercase text-[11px] tracking-wider transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {isGenerating && <div className="w-3 h-3 border-2 border-white/20 border-t-white rounded-full animate-spin" />}
                {isGenerating ? 'GENERATING...' : 'Generate Report'}
              </button>
              <button
                onClick={() => onApplyFixes(doc)}
                className="px-6 py-2 rounded bg-white text-black font-bold uppercase text-[11px] tracking-wider hover:bg-neon-pink transition-all shadow-lg shadow-white/5"
              >
                Apply Fixes
              </button>
            </div>
          </div>
        </motion.div>
      </div>

      <ReportFormatModal 
        isOpen={isFormatModalOpen} 
        onClose={() => setIsFormatModalOpen(false)} 
        onSelectFormat={handleFormatSelect}
      />
    </AnimatePresence>
  );
}
