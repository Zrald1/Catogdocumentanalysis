import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, FileText, Download, Trash2, Eye } from 'lucide-react';

interface FileBrowserModalProps {
  isOpen: boolean;
  onClose: () => void;
  files: { name: string; status: 'pending' | 'processing' | 'complete' | 'error'; contentAvailable?: boolean; restored?: boolean }[];
}

export default function FileBrowserModal({ isOpen, onClose, files }: FileBrowserModalProps) {
  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-black/80 backdrop-blur-sm"
          />
          
          <motion.div 
            initial={{ scale: 0.95, opacity: 0, y: 20 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.95, opacity: 0, y: 20 }}
            className="relative w-full max-w-2xl bg-panel-bg border border-white/10 rounded-xl shadow-2xl flex flex-col max-h-[80vh] overflow-hidden"
          >
            <div className="p-6 border-b border-white/10 flex items-center justify-between bg-black/20">
              <div className="flex items-center space-x-3">
                <div className="p-2 bg-neon-cyan/20 border border-neon-cyan/30 rounded-lg">
                  <FileText size={20} className="text-neon-cyan" />
                </div>
                <div>
                  <h2 className="text-sm font-black uppercase tracking-[0.2em] text-white">Payload Browser</h2>
                  <p className="text-[10px] text-white/40 uppercase font-bold tracking-tight">Active session document library</p>
                </div>
              </div>
              <button 
                onClick={onClose}
                className="p-2 hover:bg-white/10 rounded-full transition-all group"
              >
                <X size={20} className="text-white/40 group-hover:text-white" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-4 custom-scrollbar">
              {files.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-20 text-white/20">
                  <FileText size={48} strokeWidth={1} className="mb-4 opacity-20" />
                  <p className="text-xs font-black uppercase tracking-widest">No documents found in current session</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-2">
                  {files.map((file, idx) => (
                    <motion.div 
                      key={`file-browser-${file.name}-${idx}`}
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: idx * 0.05 }}
                      className="group flex items-center justify-between p-4 bg-white/[0.03] border border-white/5 rounded-lg hover:bg-white/[0.06] hover:border-white/10 transition-all"
                    >
                      <div className="flex items-center space-x-4">
                        <div className={`p-2 rounded bg-black/40 ${file.status === 'complete' ? 'text-success-green' : file.status === 'error' ? 'text-error-red' : 'text-white/40'}`}>
                          <FileText size={18} />
                        </div>
                        <div>
                          <p className="text-[11px] font-black tracking-wider text-white truncate max-w-[300px]">
                            {file.name}
                          </p>
                          <div className="flex items-center space-x-2 mt-1">
                            <span className={`text-[8px] font-black uppercase px-1.5 py-0.5 rounded ${
                               file.status === 'complete' ? 'bg-success-green/20 text-success-green' : 
                               file.status === 'processing' ? 'bg-neon-yellow/20 text-neon-yellow' : 
                               file.status === 'error' ? 'bg-error-red/20 text-error-red' :
                               'bg-white/10 text-white/40'
                             }`}>
                              {file.status}
                            </span>
                            <span className="text-[8px] text-white/20 font-bold uppercase tracking-widest">TYPE: PDF/DOCX</span>
                            {!file.contentAvailable && (
                              <span className="text-[8px] text-neon-yellow font-bold uppercase tracking-widest">METADATA ONLY</span>
                            )}
                            {file.restored && (
                              <span className="text-[8px] text-neon-cyan font-bold uppercase tracking-widest">RESTORED</span>
                            )}
                          </div>
                        </div>
                      </div>
                      
                      <div className="flex items-center space-x-2 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button className="p-2 hover:bg-white/10 rounded-md text-white/40 hover:text-white transition-colors" title="View Source">
                          <Eye size={14} />
                        </button>
                        <button className="p-2 hover:bg-white/10 rounded-md text-white/40 hover:text-white transition-colors" title="Download">
                          <Download size={14} />
                        </button>
                        <button className="p-2 hover:bg-white/10 rounded-md text-white/40 hover:text-neon-pink transition-colors" title="Delete">
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </motion.div>
                  ))}
                </div>
              )}
            </div>

            <div className="p-4 border-t border-white/10 bg-black/40 flex items-center justify-between">
              <span className="text-[8px] font-black uppercase tracking-widest text-white/20 italic">
                Total Payloads Detected: {files.length}
              </span>
              <button 
                onClick={onClose}
                className="px-6 py-2 bg-white text-black text-[10px] font-black uppercase tracking-widest rounded hover:bg-neon-cyan transition-all"
              >
                Close Browser
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
