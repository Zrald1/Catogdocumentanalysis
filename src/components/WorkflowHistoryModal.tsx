/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Trash2, FileText, Search, AlertCircle, CheckCircle2, Clock, ChevronRight } from 'lucide-react';
import { DocumentAnalysis } from '../types';

interface WorkflowHistoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  analyses: DocumentAnalysis[];
  onSelect: (analysis: DocumentAnalysis) => void;
  onDelete: (id: string) => void;
}

const formatDate = (iso?: string): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    + ' '
    + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
};

const getSeverityColor = (count: number) => {
  if (count === 0) return 'text-success-green';
  if (count <= 2) return 'text-neon-yellow';
  return 'text-error-red';
};

export default function WorkflowHistoryModal({
  isOpen,
  onClose,
  analyses,
  onSelect,
  onDelete,
}: WorkflowHistoryModalProps) {
  const [search, setSearch] = useState('');
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const filtered = analyses.filter((a) =>
    a.fileName.toLowerCase().includes(search.toLowerCase()),
  );

  const handleDelete = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (pendingDelete === id) {
      onDelete(id);
      setPendingDelete(null);
    } else {
      setPendingDelete(id);
    }
  };

  const handleSelect = (analysis: DocumentAnalysis) => {
    onSelect(analysis);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          key="history-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
          onClick={onClose}
        >
          <motion.div
            key="history-panel"
            initial={{ opacity: 0, scale: 0.95, y: 24 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 24 }}
            transition={{ type: 'spring', stiffness: 340, damping: 30 }}
            className="relative w-[640px] max-h-[80vh] flex flex-col bg-[#0D0D0F] border border-white/10 rounded-xl shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-white/5 bg-black/40">
              <div className="flex items-center gap-3">
                <Clock size={14} className="text-neon-blue" />
                <span className="text-[11px] font-black uppercase tracking-[0.25em] text-white">
                  Workflow History
                </span>
                <span className="px-2 py-0.5 rounded-full bg-neon-blue/10 text-neon-blue text-[9px] font-black tracking-widest border border-neon-blue/20">
                  {analyses.length}
                </span>
              </div>
              <button
                onClick={onClose}
                className="text-white/30 hover:text-white transition-colors p-1 rounded hover:bg-white/5"
              >
                <X size={16} />
              </button>
            </div>

            {/* Search */}
            <div className="px-6 py-3 border-b border-white/5 bg-black/20">
              <div className="relative">
                <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />
                <input
                  type="text"
                  placeholder="Search workflows..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full pl-8 pr-4 py-2 bg-white/5 border border-white/10 rounded-lg text-[11px] text-white placeholder-white/25 focus:outline-none focus:border-neon-blue/50 transition-colors"
                />
              </div>
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto custom-scrollbar">
              {filtered.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-40 text-white/20 gap-3">
                  <FileText size={28} strokeWidth={1} />
                  <p className="text-[10px] uppercase tracking-widest font-bold">
                    {search ? 'No matching workflows' : 'No workflow history yet'}
                  </p>
                </div>
              ) : (
                <div className="p-4 space-y-2">
                  {filtered.map((analysis) => {
                    const highFindings = analysis.findings.filter((f) => f.severity === 'high').length;
                    const isConfirmingDelete = pendingDelete === analysis.id;

                    return (
                      <motion.div
                        key={analysis.id}
                        layout
                        initial={{ opacity: 0, x: -8 }}
                        animate={{ opacity: 1, x: 0 }}
                        className="group flex items-center gap-3 p-3 rounded-lg border border-white/5 bg-white/[0.02] hover:border-neon-blue/30 hover:bg-neon-blue/5 cursor-pointer transition-all"
                        onClick={() => handleSelect(analysis)}
                      >
                        {/* Icon */}
                        <div className="shrink-0 w-9 h-9 rounded-lg bg-neon-blue/10 border border-neon-blue/20 flex items-center justify-center">
                          <FileText size={14} className="text-neon-blue" />
                        </div>

                        {/* Info */}
                        <div className="flex-1 min-w-0">
                          <p className="text-[12px] font-bold text-white truncate">{analysis.fileName}</p>
                          <p className="text-[9px] uppercase tracking-widest text-white/30 mt-0.5">
                            {formatDate(analysis.createdAt)}
                          </p>
                        </div>

                        {/* Stats */}
                        <div className="shrink-0 flex items-center gap-3 text-[9px] font-black uppercase tracking-widest">
                          <div className="flex items-center gap-1">
                            <AlertCircle size={10} className={getSeverityColor(highFindings)} />
                            <span className={getSeverityColor(highFindings)}>{highFindings} HIGH</span>
                          </div>
                          <div className="flex items-center gap-1">
                            <CheckCircle2 size={10} className="text-success-green" />
                            <span className="text-success-green">{analysis.corrections.length} FIX</span>
                          </div>
                          <div className="flex items-center gap-1">
                            <FileText size={10} className="text-neon-cyan" />
                            <span className="text-neon-cyan">{analysis.obligations.length} OBLIG</span>
                          </div>
                        </div>

                        {/* Delete */}
                        <button
                          title={isConfirmingDelete ? 'Click again to confirm delete' : 'Delete this workflow'}
                          onClick={(e) => handleDelete(analysis.id, e)}
                          onBlur={() => setPendingDelete(null)}
                          className={`shrink-0 p-1.5 rounded transition-all ${
                            isConfirmingDelete
                              ? 'bg-error-red text-white'
                              : 'text-white/20 hover:text-error-red hover:bg-error-red/10 opacity-0 group-hover:opacity-100'
                          }`}
                        >
                          <Trash2 size={12} />
                        </button>

                        <ChevronRight
                          size={13}
                          className="shrink-0 text-white/10 group-hover:text-neon-blue transition-colors"
                        />
                      </motion.div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Footer */}
            {analyses.length > 0 && (
              <div className="px-6 py-3 border-t border-white/5 bg-black/40 flex items-center justify-between">
                <span className="text-[9px] uppercase tracking-widest text-white/25 font-bold">
                  Click a workflow to open · Click trash to delete
                </span>
                <span className="text-[9px] uppercase tracking-widest text-white/20 font-bold">
                  {filtered.length} shown
                </span>
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
