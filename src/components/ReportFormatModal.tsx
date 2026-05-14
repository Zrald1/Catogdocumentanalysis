import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, FileText, FileCode, FileType, Download, CheckCircle2 } from 'lucide-react';

interface ReportFormatModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectFormat: (format: 'txt' | 'pdf' | 'docx') => void;
}

export default function ReportFormatModal({ isOpen, onClose, onSelectFormat }: ReportFormatModalProps) {
  const formats = [
    { 
      id: 'txt' as const, 
      name: 'Plain Text', 
      desc: 'Standard unformatted log file', 
      icon: FileText, 
      color: 'white/40',
      hoverColor: 'white'
    },
    { 
      id: 'docx' as const, 
      name: 'Word Document', 
      desc: 'Formatted .docx with styled tables', 
      icon: FileCode, 
      color: 'neon-cyan',
      hoverColor: 'neon-cyan'
    },
    { 
      id: 'pdf' as const, 
      name: 'PDF Document', 
      desc: 'Enterprise-grade print-ready report', 
      icon: FileType, 
      color: 'neon-pink',
      hoverColor: 'neon-pink'
    }
  ];

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-black/80 backdrop-blur-md"
          />
          
          <motion.div 
            initial={{ scale: 0.9, opacity: 0, y: 20 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.9, opacity: 0, y: 20 }}
            className="relative w-full max-w-lg bg-[#0D0D0F] border border-white/10 rounded-2xl shadow-[0_0_50px_rgba(0,0,0,0.5)] overflow-hidden"
          >
            <div className="p-8">
              <div className="flex items-center justify-between mb-8">
                <div>
                  <h2 className="text-xl font-black uppercase tracking-widest text-white">Generate Report</h2>
                  <p className="text-[10px] text-white/40 font-bold uppercase tracking-widest mt-1">Select output format for export</p>
                </div>
                <button 
                  onClick={onClose}
                  className="p-2 hover:bg-white/5 rounded-full transition-all text-white/40 hover:text-white"
                >
                  <X size={20} />
                </button>
              </div>

              <div className="space-y-3">
                {formats.map((format, idx) => (
                  <button
                    key={format.id}
                    onClick={() => onSelectFormat(format.id)}
                    className="w-full group flex items-center p-4 bg-white/[0.02] border border-white/5 rounded-xl hover:bg-white/[0.05] hover:border-white/10 transition-all text-left"
                  >
                    <div className={`p-4 rounded-lg bg-black/40 mr-4 group-hover:scale-110 transition-transform`}>
                      <format.icon size={24} className={`text-${format.color}`} />
                    </div>
                    <div className="flex-1">
                      <h3 className="text-sm font-bold text-white uppercase tracking-tight">{format.name}</h3>
                      <p className="text-[11px] text-white/30 italic">{format.desc}</p>
                    </div>
                    <div className="w-8 h-8 rounded-full border border-white/10 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                      <Download size={14} className="text-white" />
                    </div>
                  </button>
                ))}
              </div>

              <div className="mt-8 pt-6 border-t border-white/5 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <CheckCircle2 size={12} className="text-success-green" />
                  <span className="text-[8px] font-black uppercase tracking-widest text-white/20">All agents verified</span>
                </div>
                <span className="text-[8px] font-black uppercase tracking-widest text-white/10">v4.0 BUILD_GEN_SYNC</span>
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
