import { motion, AnimatePresence } from 'motion/react';
import { Database, FileText, RefreshCw, Search, Trash2, X } from 'lucide-react';
import { KnowledgeBase, KnowledgeBaseIndexedDocument } from '../types';

type KnowledgeBaseDocumentState = {
  status: 'loading' | 'success' | 'error';
  message: string;
  documents: KnowledgeBaseIndexedDocument[];
  selectedFiles: string[];
};

interface KnowledgeBaseFilesModalProps {
  isOpen: boolean;
  knowledgeBase: KnowledgeBase | null;
  documentState?: KnowledgeBaseDocumentState;
  searchTerm: string;
  onClose: () => void;
  onSearchChange: (value: string) => void;
  onRefresh: () => void;
  onToggleFileSelection: (fileName: string) => void;
  onToggleVisibleSelection: (fileNames: string[], shouldSelect: boolean) => void;
  onClearSelection: () => void;
  onDeleteSelected: () => void;
}

export default function KnowledgeBaseFilesModal({
  isOpen,
  knowledgeBase,
  documentState,
  searchTerm,
  onClose,
  onSearchChange,
  onRefresh,
  onToggleFileSelection,
  onToggleVisibleSelection,
  onClearSelection,
  onDeleteSelected,
}: KnowledgeBaseFilesModalProps) {
  const normalizedSearch = searchTerm.trim().toLowerCase();
  const allDocuments = documentState?.documents || [];
  const filteredDocuments = normalizedSearch
    ? allDocuments.filter((document) =>
        `${document.fileName} ${document.chunkCount}`.toLowerCase().includes(normalizedSearch),
      )
    : allDocuments;
  const selectedFiles = documentState?.selectedFiles || [];
  const allVisibleSelected = filteredDocuments.length > 0
    && filteredDocuments.every((document) => selectedFiles.includes(document.fileName));

  return (
    <AnimatePresence>
      {isOpen && knowledgeBase && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-6">
          <motion.button
            type="button"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-black/80 backdrop-blur-md"
          />

          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 18 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 18 }}
            className="relative flex h-[78vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#09090B] shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-white/10 bg-[#111114] px-6 py-5">
              <div className="flex items-center gap-4">
                <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-neon-cyan/20 bg-neon-cyan/10 text-neon-cyan">
                  <Database size={18} />
                </div>
                <div>
                  <div className="text-[10px] font-black uppercase tracking-[0.3em] text-white/40">
                    Knowledge Base Files
                  </div>
                  <div className="text-sm font-semibold text-white">{knowledgeBase.name}</div>
                  <div className="text-[10px] text-white/35">
                    {allDocuments.length} indexed • {filteredDocuments.length} shown • {selectedFiles.length} selected
                  </div>
                </div>
              </div>

              <button
                type="button"
                onClick={onClose}
                className="rounded-full p-2 text-white/40 transition-all hover:bg-white/10 hover:text-white"
              >
                <X size={18} />
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-3 border-b border-white/5 bg-black/30 px-6 py-4">
              <div className="relative min-w-[260px] flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-white/25" size={13} />
                <input
                  type="text"
                  value={searchTerm}
                  onChange={(event) => onSearchChange(event.target.value)}
                  placeholder="Search indexed files..."
                  className="w-full rounded-xl border border-white/10 bg-black/40 py-2.5 pl-9 pr-3 text-[10px] text-white outline-none transition-all focus:border-neon-cyan"
                />
              </div>

              <button
                type="button"
                onClick={onRefresh}
                disabled={documentState?.status === 'loading'}
                className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-[9px] font-black uppercase tracking-widest text-white/70 transition-all hover:bg-white/10 hover:text-neon-cyan disabled:opacity-40"
              >
                <RefreshCw size={12} />
                Refresh
              </button>

              <button
                type="button"
                onClick={() => onToggleVisibleSelection(filteredDocuments.map((document) => document.fileName), !allVisibleSelected)}
                disabled={filteredDocuments.length === 0 || documentState?.status === 'loading'}
                className="rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-[9px] font-black uppercase tracking-widest text-white/70 transition-all hover:bg-white/10 hover:text-neon-cyan disabled:opacity-40"
              >
                {allVisibleSelected ? 'Clear Visible' : 'Select Visible'}
              </button>

              <button
                type="button"
                onClick={onClearSelection}
                disabled={selectedFiles.length === 0}
                className="rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-[9px] font-black uppercase tracking-widest text-white/70 transition-all hover:bg-white/10 hover:text-neon-cyan disabled:opacity-40"
              >
                Clear Selection
              </button>

              <button
                type="button"
                onClick={onDeleteSelected}
                disabled={selectedFiles.length === 0 || documentState?.status === 'loading'}
                className="inline-flex items-center gap-2 rounded-xl border border-error-red/30 bg-error-red/10 px-4 py-2.5 text-[9px] font-black uppercase tracking-widest text-error-red transition-all disabled:opacity-40"
              >
                <Trash2 size={12} />
                Delete Selected
              </button>
            </div>

            <div className="px-6 py-3 text-[10px] font-bold">
              <span
                className={
                  documentState?.status === 'error'
                    ? 'text-error-red'
                    : documentState?.status === 'loading'
                      ? 'text-neon-cyan'
                      : 'text-white/50'
                }
              >
                {documentState?.message || 'Load embedded files for this knowledge base.'}
              </span>
            </div>

            <div className="flex-1 overflow-hidden px-6 pb-6">
              <div className="h-full overflow-hidden rounded-2xl border border-white/5">
                <div className="grid grid-cols-[auto,1fr,auto] gap-3 border-b border-white/5 bg-white/[0.03] px-4 py-3 text-[9px] font-black uppercase tracking-[0.25em] text-white/35">
                  <span>Select</span>
                  <span>File</span>
                  <span>Chunks</span>
                </div>

                <div className="h-full max-h-full overflow-y-auto custom-scrollbar">
                  {filteredDocuments.map((document) => (
                    <label
                      key={`${knowledgeBase.id}-${document.fileName}`}
                      className="grid grid-cols-[auto,1fr,auto] items-center gap-3 border-b border-white/5 bg-white/[0.02] px-4 py-3 text-[10px] text-white/75 last:border-b-0 hover:bg-white/[0.04]"
                    >
                      <input
                        type="checkbox"
                        checked={selectedFiles.includes(document.fileName)}
                        onChange={() => onToggleFileSelection(document.fileName)}
                        className="accent-neon-cyan"
                      />
                      <div className="flex items-center gap-3 overflow-hidden">
                        <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-black/30 text-white/45">
                          <FileText size={14} />
                        </div>
                        <span className="truncate">{document.fileName}</span>
                      </div>
                      <span className="text-right text-white/35">{document.chunkCount}</span>
                    </label>
                  ))}

                  {allDocuments.length === 0 && documentState?.status === 'success' && (
                    <div className="flex h-full min-h-48 flex-col items-center justify-center px-4 py-10 text-center text-white/30">
                      <FileText size={34} className="mb-3 opacity-30" />
                      <div className="text-[10px] font-black uppercase tracking-[0.3em]">No Indexed Files</div>
                      <div className="mt-2 max-w-md text-[10px] text-white/25">
                        This knowledge base does not have embedded files yet.
                      </div>
                    </div>
                  )}

                  {allDocuments.length > 0 && filteredDocuments.length === 0 && (
                    <div className="flex h-full min-h-48 flex-col items-center justify-center px-4 py-10 text-center text-white/30">
                      <Search size={28} className="mb-3 opacity-30" />
                      <div className="text-[10px] font-black uppercase tracking-[0.3em]">No Search Matches</div>
                      <div className="mt-2 max-w-md text-[10px] text-white/25">
                        No indexed files match the current search filter.
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
