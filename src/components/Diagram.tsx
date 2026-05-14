/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { motion } from 'motion/react';
import { FileText, Cpu, CheckCircle, Database, Network, Eye } from 'lucide-react';
import { AppConfig, ExecutionMode } from '../types';
import { getSpecialistAgents } from '../lib/agentConfig';

interface DiagramProps {
  activeStep: number;
  files: { name: string; status: 'pending' | 'processing' | 'complete' | 'error'; contentAvailable?: boolean; restored?: boolean }[];
  onGraphClick: () => void;
  onViewFiles: () => void;
  config: AppConfig;
  executionMode: ExecutionMode;
}

export default function Diagram({ activeStep, files, onGraphClick, onViewFiles, config, executionMode }: DiagramProps) {
  const specialistSteps = getSpecialistAgents(config).map((agent, index) => ({
    id: index + 3,
    label: `Agent ${index + 1}: ${agent.name}`,
    icon: Cpu,
  }));
  const specialistStartStep = 3;
  const finalReportStep = specialistSteps.length + 3;
  const highlightParallelSpecialists = executionMode === 'parallel'
    && activeStep >= specialistStartStep
    && activeStep < finalReportStep;

  const steps = [
    { id: 1, label: 'Input Docs', icon: FileText },
    { id: 2, label: 'RAG Context', icon: Database },
    ...specialistSteps,
    { id: specialistSteps.length + 3, label: 'Final Report', icon: CheckCircle },
  ];
  return (
    <div className="grid grid-cols-[140px_1fr] h-full">
      {/* File List Sidebar */}
      <div className="border-r border-white/5 bg-black/20 flex flex-col overflow-hidden">
        <div className="p-3 border-b border-white/5 flex items-center justify-between">
          <div className="flex flex-col">
            <span className="text-[9px] font-black uppercase tracking-widest text-white/40">Active Payloads</span>
            <button 
              onClick={onViewFiles}
              className="mt-1 text-[8px] font-black uppercase tracking-widest text-neon-cyan hover:text-white transition-colors flex items-center gap-1"
            >
              <Eye size={10} /> View files
            </button>
          </div>
          <div className="flex space-x-1">
            <div className={`w-1 h-1 rounded-full ${activeStep > 0 ? 'bg-success-green' : 'bg-white/20'}`} />
            <div className="w-1 h-1 rounded-full bg-white/20" />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2 custom-scrollbar">
          <motion.div className="space-y-1.5">
            {files.length === 0 ? (
              <div className="p-4 text-center opacity-20">
                <FileText size={16} className="mx-auto mb-2" />
                <span className="text-[8px] uppercase font-bold tracking-widest">No Payloads</span>
              </div>
            ) : (
              files.map((file, idx) => (
                <motion.div
                  key={`diag-file-${file.name}-${idx}`}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: idx * 0.1 }}
                   className={`p-2 rounded border border-white/5 bg-white/[0.02] flex items-center space-x-2 transition-all duration-500
                     ${file.status === 'complete' ? 'border-success-green/30 bg-success-green/5' : ''}
                     ${file.status === 'error' ? 'border-error-red/30 bg-error-red/5' : ''}
                   `}
                 >
                   <div className={`w-1 h-1 rounded-full flex-shrink-0 animate-pulse
                    ${file.status === 'complete' ? 'bg-success-green shadow-[0_0_5px_#00FF88]' : file.status === 'processing' ? 'bg-neon-yellow' : file.status === 'error' ? 'bg-error-red shadow-[0_0_5px_#FF4D6D]' : 'bg-white/20'}
                   `} />
                    <span className={`text-[9px] font-bold truncate flex-1 tracking-tight
                     ${file.status === 'complete' ? 'text-success-green' : file.status === 'error' ? 'text-error-red' : 'text-white'}
                    `}>
                     {file.name}
                   </span>
                   {!file.contentAvailable && (
                     <span className="text-[7px] font-black uppercase tracking-widest text-neon-yellow">META</span>
                   )}
                 </motion.div>
               ))
            )}
          </motion.div>
        </div>
        <div className="p-2 border-t border-white/5 bg-black/40">
           <div className="flex items-center justify-between px-1">
              <span className="text-[7px] uppercase font-black text-white/20 tracking-widest">Storage Status</span>
              <span className="text-[7px] uppercase font-black text-white/40 tracking-widest">SECURE</span>
           </div>
        </div>
      </div>

      {/* Main Flowchart Area */}
      <div className="flex flex-col items-center justify-start h-full p-6 relative overflow-hidden custom-scrollbar overflow-y-auto">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(204,255,0,0.04)_0%,transparent_70%)] pointer-events-none" />
        
        {/* Knowledge Graph Button Trigger */}
        <button 
          onClick={onGraphClick}
          className="mb-8 z-20 group relative flex items-center space-x-3 px-4 py-2 bg-neon-cyan border border-neon-cyan text-black rounded shadow-[0_0_15px_rgba(0,255,136,0.2)] hover:shadow-[0_0_25px_rgba(0,255,136,0.4)] transition-all active:scale-95"
        >
          <div className="absolute -inset-1 bg-neon-cyan/20 blur opacity-0 group-hover:opacity-100 transition-opacity rounded" />
          <Network size={16} strokeWidth={2.5} />
          <span className="text-[10px] font-black uppercase tracking-[0.2em]">View Knowledge Graph</span>
        </button>

        <div className="relative flex flex-col items-center space-y-10 pb-10">
          {/* Continuous background line linking all steps */}
          <div className="absolute top-7 bottom-7 w-0.5 bg-white/5 left-1/2 -translate-x-1/2" />
          
          {steps.map((step, index) => {
          const Icon = step.icon;
          const isSpecialistStep = step.id >= specialistStartStep && step.id < finalReportStep;
          const isActive = highlightParallelSpecialists && isSpecialistStep
            ? true
            : activeStep >= step.id;
          const isCurrent = highlightParallelSpecialists && isSpecialistStep
            ? true
            : activeStep === step.id;
          const isLineActive = highlightParallelSpecialists && step.id >= specialistStartStep && step.id < finalReportStep - 1
            ? true
            : activeStep > step.id;

          return (
            <div key={step.id} className="relative flex flex-col items-center">
              {/* Progress Line Segment linking this step to the next */}
              {index < steps.length - 1 && (
                <div className="absolute top-14 h-10 w-[2px] left-1/2 -translate-x-1/2">
                  <motion.div
                    initial={{ height: 0 }}
                    animate={{ height: isLineActive ? '100%' : '0' }}
                    className="w-full bg-neon-yellow shadow-[0_0_10px_#CCFF00] transition-all duration-700 origin-top"
                  />
                </div>
              )}

              <motion.div
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{
                  opacity: 1,
                  scale: isCurrent ? 1.1 : 1,
                  borderColor: isActive ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.1)',
                  color: isActive ? 'white' : 'rgba(255,255,255,0.2)',
                }}
                className={`w-14 h-14 z-10 transition-all duration-500 rounded-md border
                  ${isCurrent ? 'rotating-border shadow-[0_0_15px_rgba(204,255,0,0.35)]' : ''}`}
              >
                <div className={isCurrent ? 'rotating-border-content' : 'w-full h-full flex items-center justify-center'}>
                  <Icon size={24} strokeWidth={1.5} />
                </div>
              </motion.div>
              
              <div className="absolute -right-4 translate-x-full top-1/2 -translate-y-1/2 whitespace-nowrap">
                <span className={`font-mono text-[9px] uppercase font-bold tracking-widest transition-colors duration-500 ${isActive ? 'text-white' : 'text-[#555]'}`}>
                  {step.label}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  </div>
  );
}
