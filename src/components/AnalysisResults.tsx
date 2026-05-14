/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { motion } from 'motion/react';
import { FileText, ChevronRight, AlertCircle, CheckCircle2, Search } from 'lucide-react';
import { DocumentAnalysis } from '../types';

interface AnalysisResultsProps {
  analyses: DocumentAnalysis[];
  onSelect: (doc: DocumentAnalysis) => void;
}

export default function AnalysisResults({ analyses, onSelect }: AnalysisResultsProps) {
  const visibleAnalyses = analyses.filter((doc) => doc.status === 'complete' || doc.status === 'error');

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar h-full bg-[#161618]">
      {visibleAnalyses.length === 0 ? (
        <div className="h-full flex flex-col items-center justify-center text-white/10 space-y-4">
          <Search size={40} strokeWidth={1} />
          <p className="text-[10px] font-mono uppercase tracking-[0.2em] opacity-50">Ingesting live data...</p>
        </div>
      ) : (
        visibleAnalyses.map((doc) => {
          const isError = doc.status === 'error';
          return (
            <motion.div
              key={doc.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              onClick={() => onSelect(doc)}
              className="group relative bg-[#1D1D20] border border-border-grey rounded-md p-4 cursor-pointer hover:border-neon-blue transition-all duration-300 overflow-hidden"
            >
              {/* Visual accent bar */}
              <div className={`absolute left-0 top-0 bottom-0 w-1 ${isError ? 'bg-error-red' : 'bg-neon-blue'} opacity-0 group-hover:opacity-100 transition-opacity`} />

              <div className="flex items-center justify-between mb-4">
                <h3 className="text-[13px] font-bold text-[#F2F2F2] tracking-tight truncate w-48 font-sans">
                  {doc.fileName}
                </h3>
                <span className={`text-[9px] px-2 py-0.5 rounded font-bold uppercase tracking-wider ${isError ? 'bg-error-red text-white' : 'bg-success-green text-black'}`}>
                  {isError ? 'ERROR' : `${doc.findings.length} GAPS`}
                </span>
              </div>

              <div className="space-y-1.5 mt-3">
                {isError && (
                  <div className="rounded border border-error-red/20 bg-error-red/5 p-2 text-[11px] leading-relaxed text-error-red font-mono">
                    Analysis failed. Check the system interface or logs for details.
                  </div>
                )}
                {doc.corrections.slice(0, 2).map((correction, idx) => (
                  <div key={`res-corr-${doc.id}-${idx}`} className="space-y-1">
                    {correction.original && (
                      <div className="text-[11px] leading-tight text-white/40 font-mono flex items-start gap-2 bg-error-red/5 p-1 rounded">
                        <span className="text-error-red font-bold">-</span>
                        <span className="line-through decoration-error-red/50 italic opacity-80">{correction.original.slice(0, 50)}...</span>
                      </div>
                    )}
                    <div className="text-[11px] leading-tight text-white/60 font-mono flex items-start gap-2 bg-success-green/5 p-1 rounded border-l border-success-green/30">
                      <span className="text-success-green font-bold">+</span>
                      <span>{correction.suggested.slice(0, 60)}...</span>
                    </div>
                  </div>
                ))}
              </div>

              {doc.obligations.length > 0 && (
                <div className="mt-3 rounded border border-neon-cyan/15 bg-neon-cyan/5 p-2">
                  <div className="text-[9px] font-black uppercase tracking-widest text-neon-cyan/80">
                    Obligation Register
                  </div>
                  <div className="mt-1 text-[10px] text-white/65 font-mono truncate">
                    {doc.obligations[0].title}
                  </div>
                </div>
              )}

              <div className="mt-4 pt-3 border-t border-white/5 flex items-center justify-between">
                <div className="flex items-center space-x-3">
                  <div className="flex items-center space-x-1">
                    <AlertCircle size={10} className="text-error-red" />
                    <span className="text-[10px] font-mono text-[#666]">CRITICAL</span>
                  </div>
                  <div className="flex items-center space-x-1">
                    <CheckCircle2 size={10} className="text-success-green" />
                    <span className="text-[10px] font-mono text-[#666]">RESOLVABLE</span>
                  </div>
                  <div className="flex items-center space-x-1">
                    <FileText size={10} className="text-neon-cyan" />
                    <span className="text-[10px] font-mono text-[#666]">{doc.obligations.length} OBLIG</span>
                  </div>
                  {doc.graphIndex && (
                    <div className="flex items-center space-x-1">
                      <FileText size={10} className="text-neon-cyan" />
                      <span className="text-[10px] font-mono text-[#666]">{doc.graphIndex.nodeCount}N/{doc.graphIndex.edgeCount}E</span>
                    </div>
                  )}
                  <div className="flex items-center space-x-1 border-l border-white/5 pl-3 ml-1">
                    <div className="w-1.5 h-1.5 rounded-full bg-success-green opacity-50" />
                    <span className="text-[9px] font-black uppercase tracking-widest text-[#666]">LobsterTrap</span>
                  </div>
                </div>
                <ChevronRight size={14} className="text-white/20 group-hover:text-neon-blue transition-colors" />
              </div>
            </motion.div>
          );
        })
      )}
    </div>
  );
}
