/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { motion } from 'motion/react';
import Diagram from './components/Diagram';
import Terminal from './components/Terminal';
import AgentChat from './components/AgentChat';
import AnalysisResults from './components/AnalysisResults';
import DocumentModal from './components/DocumentModal';
import ConfigurationModal from './components/ConfigurationModal';
import KnowledgeGraphModal from './components/KnowledgeGraphModal';
import FileBrowserModal from './components/FileBrowserModal';
import WorkflowHistoryModal from './components/WorkflowHistoryModal';
import ApplyFixesModal from './components/ApplyFixesModal';
import VisionCaptureModal from './components/VisionCaptureModal';
import { Message, DocumentAnalysis, ExecutionMode, AppConfig, AgentExecutionMessage, VisionPreparedCapture } from './types';
import { runMultiAgentAnalysis, runParallelMultiAgentAnalysis } from './services/aiAgents';
import { Upload, Play, ShieldCheck, Zap, Database, ChevronDown, Repeat, Layers, Network, Download, FileText, File as FileIcon, LogIn, BadgeCheck, History, Trash2, Camera, Square, ScrollText } from 'lucide-react';
import { generateConsolidatedTxtReport, generateConsolidatedPdfReport, generateConsolidatedDocxReport } from './services/reportGenerator';
import { createDefaultAppConfig, loadPersistedAppConfig, persistAppConfig } from './lib/appConfigStorage';
import { loadPersistedAnalysisHistory, persistAnalysisHistory, UploadedFileMetadata } from './lib/analysisHistoryStorage';
import { ensureDocumentAnalysisGraph } from './lib/analysisGraph';
import { readFileForAnalysis } from './lib/fileContent';
import { getPipelineFinalStep, getSpecialistAgents } from './lib/agentConfig';
import { analyzeVisionCapture } from './services/vision';
import { clearRuntimeBreadcrumb, markRuntimeBreadcrumb, openSystemLog, writeSystemLog } from './lib/systemLogger';

type DisplayFile = {
  name: string;
  status: 'pending' | 'processing' | 'complete' | 'error';
  contentAvailable?: boolean;
  restored?: boolean;
};

type PreparedUploadFile = {
  name: string;
  content: string;
};

const toRestoredDisplayFiles = (files: UploadedFileMetadata[]): DisplayFile[] => (
  files.map((file) => ({
    name: file.name,
    status: file.status,
    contentAvailable: false,
    restored: true,
  }))
);

const mergePreparedFiles = (
  existingFiles: PreparedUploadFile[],
  incomingFiles: PreparedUploadFile[],
) => {
  const merged = new Map(existingFiles.map((file) => [file.name, file]));
  incomingFiles.forEach((file) => {
    merged.set(file.name, file);
  });
  return Array.from(merged.values());
};

const delay = (ms: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, ms);
});

const getAnalysisHistoryPersistenceSignature = (
  analyses: DocumentAnalysis[],
  uploadedFileMetadata: UploadedFileMetadata[],
) => JSON.stringify({
  analyses: analyses.map(({ graph, graphIndex, ...analysis }) => analysis),
  uploadedFileMetadata,
});

export default function App() {
  const [initialAppConfigState] = useState(() => loadPersistedAppConfig(createDefaultAppConfig()));
  const [messages, setMessages] = useState<Message[]>([]);
  const [agentExecutionMessages, setAgentExecutionMessages] = useState<AgentExecutionMessage[]>([]);
  const [analyses, setAnalyses] = useState<DocumentAnalysis[]>([]);
  const [activeStep, setActiveStep] = useState(0);
  const [allFiles, setAllFiles] = useState<DisplayFile[]>([]);
  const [uploadedFiles, setUploadedFiles] = useState<{ name: string; content: string }[]>([]);
  const [uploadedFileMetadata, setUploadedFileMetadata] = useState<UploadedFileMetadata[]>([]);

  const [executionMode, setExecutionMode] = useState<ExecutionMode>('sequential');
  const [showModeMenu, setShowModeMenu] = useState(false);
  const [showReportMenu, setShowReportMenu] = useState(false);

  const [selectedDoc, setSelectedDoc] = useState<DocumentAnalysis | null>(null);

  useEffect(() => {
    if (selectedDoc) {
      localStorage.setItem('catog-selected-doc-id', selectedDoc.id);
    } else {
      localStorage.removeItem('catog-selected-doc-id');
    }
  }, [selectedDoc]);

  useEffect(() => {
    if (analyses.length > 0 && !selectedDoc) {
      const savedId = localStorage.getItem('catog-selected-doc-id');
      if (savedId) {
        const found = analyses.find((a) => a.id === savedId);
        if (found) {
          setSelectedDoc(found);
        }
      }
    }
  }, [analyses, selectedDoc]);
  const [applyFixesAnalysisId, setApplyFixesAnalysisId] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isConfigOpen, setIsConfigOpen] = useState(false);
  const [configTab, setConfigTab] = useState<'agents' | 'kb' | 'vision' | 'logs'>('agents');
  const [isGraphOpen, setIsGraphOpen] = useState(false);
  const [isFileBrowserOpen, setIsFileBrowserOpen] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isApplyFixesOpen, setIsApplyFixesOpen] = useState(false);
  const [isVisionCaptureOpen, setIsVisionCaptureOpen] = useState(false);
  const [captureAnnouncement, setCaptureAnnouncement] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const analysisHistoryPersistenceErrorRef = useRef<string | null>(null);
  const analysisHistoryHydratedRef = useRef(false);
  const lastPersistedAnalysisHistoryRef = useRef<string | null>(null);
  const activeRunRef = useRef<{ id: number; cancelled: boolean }>({ id: 0, cancelled: false });
  const [appConfig, setAppConfig] = useState<AppConfig>(initialAppConfigState.config);

  const activeKBs = appConfig.knowledgeBases.filter(kb => appConfig.selectedKBIds.includes(kb.id));
  const kbSettings = activeKBs[0] || appConfig.knowledgeBases[0];
  const hasSessionDocuments = allFiles.length > 0 || uploadedFiles.length > 0 || uploadedFileMetadata.length > 0 || analyses.length > 0;

  // True once every configured specialist has posted a review-complete event for the current run.
  const allSpecialistsComplete = useMemo(() => {
    const specialists = getSpecialistAgents(appConfig);
    const reviewDone = (agentId: string) =>
      agentExecutionMessages.some(
        (m) => m.agent === agentId && m.stage === 'review' && (m.status === 'complete' || m.status === 'fallback'),
      );
    return specialists.length > 0 && specialists.every((agent) => reviewDone(agent.id));
  }, [agentExecutionMessages, appConfig]);

  const addLog = useCallback((msg: Message) => {
    setMessages((prev) => {
      const existingIdx = prev.findIndex(m => m.id === msg.id);
      let next = [...prev];
      if (existingIdx === -1) {
        next = [...prev, msg];
      } else {
        next[existingIdx] = msg;
      }
      
      if (next.length > 200) {
        return next.slice(next.length - 200);
      }
      return next;
    });
  }, []);

  const addAgentExecutionEvent = useCallback((event: AgentExecutionMessage) => {
    setAgentExecutionMessages((prev) => {
      const existingIdx = prev.findIndex((currentEvent) => currentEvent.id === event.id);
      let next = [...prev];
      if (existingIdx === -1) {
        next = [...prev, event];
      } else {
        next[existingIdx] = event;
      }

      if (next.length > 500) {
        return next.slice(next.length - 500);
      }
      return next;
    });
  }, []);

  const upsertAnalysisReplacingPlaceholders = useCallback((analysis: DocumentAnalysis) => {
    setAnalyses((prev) => {
      const withoutPlaceholder = prev.filter((currentAnalysis) => !(
        currentAnalysis.status === 'analyzing'
        && currentAnalysis.fileName === analysis.fileName
      ));
      const existingIndex = withoutPlaceholder.findIndex((currentAnalysis) => currentAnalysis.id === analysis.id);
      if (existingIndex === -1) {
        return [analysis, ...withoutPlaceholder];
      }

      const next = [...withoutPlaceholder];
      next[existingIndex] = analysis;
      return next;
    });
  }, []);

  const deleteAnalysis = useCallback((id: string) => {
    setAnalyses((prev) => {
      const target = prev.find((a) => a.id === id);
      if (target) {
        setUploadedFileMetadata((m) => m.filter((meta) => meta.name !== target.fileName));
      }
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  useEffect(() => {
    if (!initialAppConfigState.error) {
      return;
    }

    addLog({
      id: 'config-restore-error',
      agent: 'system',
      text: `CONFIG_RESTORE_WARNING: ${initialAppConfigState.error}`,
      timestamp: new Date(),
      isComplete: true,
    });
  }, [addLog, initialAppConfigState.error]);

  // Hydrate async analysis history
  useEffect(() => {
    loadPersistedAnalysisHistory().then((history) => {
      setAnalyses(history.analyses);
      setUploadedFileMetadata(history.uploadedFileMetadata);
      setAllFiles(toRestoredDisplayFiles(history.uploadedFileMetadata));
      lastPersistedAnalysisHistoryRef.current = getAnalysisHistoryPersistenceSignature(
        history.analyses,
        history.uploadedFileMetadata,
      );
      analysisHistoryHydratedRef.current = true;
      
      if (history.error) {
        addLog({
          id: `analysis-history-restore-error-${Date.now()}`,
          agent: 'system',
          text: `HISTORY_RESTORE_WARNING: ${history.error}`,
          timestamp: new Date(),
          isComplete: true,
        });
      } else if (history.analyses.length > 0 || history.uploadedFileMetadata.length > 0) {
        addLog({
          id: `analysis-history-restored-${Date.now()}`,
          agent: 'system',
          text: `HISTORY_RESTORED: Restored ${history.analyses.length} prior analyses and ${history.uploadedFileMetadata.length} uploaded-file metadata record(s).`,
          timestamp: new Date(),
          isComplete: true,
        });
      }
    });
  }, [addLog]);

  useEffect(() => {
    setAnalyses((prev) => {
      let hasChanges = false;
      const next = prev.map((analysis) => {
        const hydratedAnalysis = ensureDocumentAnalysisGraph(analysis);
        if (!analysis.graph || !analysis.graphIndex) {
          hasChanges = true;
          return hydratedAnalysis;
        }
        return analysis;
      });

      return hasChanges ? next : prev;
    });
  }, []);

  useEffect(() => {
    if (!analysisHistoryHydratedRef.current) {
      return;
    }

    const persistenceSignature = getAnalysisHistoryPersistenceSignature(analyses, uploadedFileMetadata);

    if (lastPersistedAnalysisHistoryRef.current === persistenceSignature) {
      return;
    }

    const persistenceTimer = window.setTimeout(async () => {
      const persistenceError = await persistAnalysisHistory(analyses, uploadedFileMetadata);
      if (persistenceError && analysisHistoryPersistenceErrorRef.current !== persistenceError) {
        analysisHistoryPersistenceErrorRef.current = persistenceError;
        addLog({
          id: `analysis-history-save-error-${Date.now()}`,
          agent: 'system',
          text: `HISTORY_SAVE_WARNING: ${persistenceError}`,
          timestamp: new Date(),
          isComplete: true,
        });
        return;
      }

      if (!persistenceError) {
        analysisHistoryPersistenceErrorRef.current = null;
        lastPersistedAnalysisHistoryRef.current = persistenceSignature;
      }
    }, 750);

    return () => window.clearTimeout(persistenceTimer);
  }, [addLog, analyses, uploadedFileMetadata]);

  useEffect(() => {
    if (!selectedDoc) {
      return;
    }

    const refreshedAnalysis = analyses.find((analysis) => analysis.id === selectedDoc.id);
    if (!refreshedAnalysis) {
      setSelectedDoc(null);
      return;
    }

    if (refreshedAnalysis !== selectedDoc) {
      setSelectedDoc(refreshedAnalysis);
    }
  }, [analyses, selectedDoc]);


  const registerPreparedFiles = useCallback((
    preparedFiles: PreparedUploadFile[],
    options?: {
      logPrefix?: string;
      citations?: Message['citations'];
      summary?: string;
    },
  ) => {
    if (preparedFiles.length === 0) {
      return uploadedFiles;
    }

    const mergedFiles = mergePreparedFiles(uploadedFiles, preparedFiles);
    setAllFiles((prev) => [
      ...prev.filter((existingFile) => !preparedFiles.some((preparedFile) => preparedFile.name === existingFile.name)),
      ...preparedFiles.map((file) => ({
        name: file.name,
        status: 'pending' as const,
        contentAvailable: true,
        restored: false,
      })),
    ]);
    setUploadedFiles(mergedFiles);
    setUploadedFileMetadata((prev) => [
      ...prev.filter((existingFile) => !preparedFiles.some((preparedFile) => preparedFile.name === existingFile.name)),
      ...preparedFiles.map((file) => ({ name: file.name, status: 'pending' as const })),
    ]);

    preparedFiles.forEach((file, idx) => {
      addLog({
        id: `${options?.logPrefix || 'upload'}-${Date.now()}-${idx}-${Math.random().toString(36).substr(2, 5)}`,
        agent: 'system',
        text: options?.summary
          ? `${options.logPrefix || 'VISION_CAPTURE'}: ${file.name} ready. ${options.summary}`
          : `Queued user document: ${file.name}. Integrity check pending.`,
        citations: options?.citations,
        timestamp: new Date(),
        isComplete: true,
      });
    });

    return mergedFiles;
  }, [addLog, uploadedFiles]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) {
      return;
    }

    const preparedFiles = await Promise.all(
      Array.from(files).map(async (file) => ({
        name: file.name,
        content: await readFileForAnalysis(file),
      })),
    );

    registerPreparedFiles(preparedFiles);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleClearWorkspaceDocuments = useCallback(() => {
    if (isProcessing || !hasSessionDocuments) {
      return;
    }

    setAllFiles([]);
    setUploadedFiles([]);
    setUploadedFileMetadata([]);
    setAnalyses([]);
    setAgentExecutionMessages([]);
    setActiveStep(0);
    setSelectedDoc(null);
    setApplyFixesAnalysisId(null);
    setIsApplyFixesOpen(false);
    setShowReportMenu(false);

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }

    addLog({
      id: `workspace-clear-${Date.now()}`,
      agent: 'system',
      text: 'WORKSPACE_RESET: Cleared uploaded files and analysis/correction results.',
      timestamp: new Date(),
      isComplete: true,
      });
  }, [addLog, hasSessionDocuments, isProcessing]);

  const handleStopProcessing = useCallback(() => {
    if (!isProcessing) {
      return;
    }

    activeRunRef.current.cancelled = true;
    clearRuntimeBreadcrumb('idle');
    void writeSystemLog({
      scope: 'app.ai-workflow',
      event: 'processing-stop-requested',
      level: 'warn',
      message: 'User requested stop while AI analysis was active.',
    });
    setIsProcessing(false);
    setActiveStep(0);
    setAllFiles((prev) => prev.map((file) => (
      file.status === 'processing' ? { ...file, status: 'pending' } : file
    )));
    setUploadedFileMetadata((prev) => prev.map((metadata) => (
      metadata.status === 'processing' ? { ...metadata, status: 'pending' } : metadata
    )));
    addLog({
      id: `processing-stopped-${Date.now()}`,
      agent: 'system',
      text: 'PROCESSING_STOPPED: Stop requested. CATOG will ignore any remaining results from the cancelled run.',
      timestamp: new Date(),
      isComplete: true,
    });
  }, [addLog, isProcessing]);

  const handleOpenSystemLog = useCallback(() => {
    setConfigTab('logs');
    setIsConfigOpen(true);
  }, []);

  const runAnalysisForFiles = useCallback(async (
    filesToAnalyze: PreparedUploadFile[],
    options?: { preserveUiState?: boolean },
  ) => {
    if (isProcessing) return;

    if (filesToAnalyze.length === 0) {
      addLog({
        id: `upload-required-${Date.now()}`,
        agent: 'system',
        text: uploadedFileMetadata.length > 0
          ? 'UPLOAD_REQUIRED: Restored file metadata is visible, but you must re-upload the actual documents before running the agents.'
          : 'UPLOAD_REQUIRED: Upload one or more real documents before executing the AI agents.',
        timestamp: new Date(),
        isComplete: true,
      });
      return;
    }

    setIsProcessing(true);
    const runId = Date.now();
    activeRunRef.current = { id: runId, cancelled: false };
    markRuntimeBreadcrumb({
      phase: 'app-analysis-run-start',
      runId: String(runId),
      details: {
        executionMode,
        files: filesToAnalyze.map((file) => file.name),
      },
    });
    void writeSystemLog({
      scope: 'app.ai-workflow',
      event: 'analysis-run-start',
      message: `Starting ${executionMode} AI analysis run for ${filesToAnalyze.length} file(s).`,
      details: {
        runId,
        executionMode,
        files: filesToAnalyze.map((file) => file.name),
      },
    });
    const isRunCancelled = () => activeRunRef.current.id !== runId || activeRunRef.current.cancelled;
    const guardedAddLog = (message: Message) => {
      if (!isRunCancelled()) {
        addLog(message);
      }
    };
    const guardedAddAgentExecutionEvent = (event: AgentExecutionMessage) => {
      if (!isRunCancelled()) {
        addAgentExecutionEvent(event);
      }
    };
    const guardedUpsertAnalysis = (analysis: DocumentAnalysis) => {
      if (!isRunCancelled()) {
        upsertAnalysisReplacingPlaceholders(analysis);
      }
    };
    const guardedSetActiveStep = (step: number) => {
      if (!isRunCancelled()) {
        setActiveStep(step);
      }
    };
    setShowModeMenu(false);
    if (!options?.preserveUiState) {
      setMessages([]);
      setAgentExecutionMessages([]);
      setAnalyses([]);
    }
    setActiveStep(0);

    const userFiles = filesToAnalyze;
    const pendingAnalyses = filesToAnalyze.map((file) => ({
      id: `pending-${runId}-${file.name}`,
      fileName: file.name,
      status: 'analyzing' as const,
      findings: [],
      corrections: [],
      obligations: [],
    }));

    setAnalyses((prev) => {
      const preserved = options?.preserveUiState ? prev : [];
      const withoutSameFiles = preserved.filter((analysis) => !filesToAnalyze.some((file) => file.name === analysis.fileName));
      return [...pendingAnalyses, ...withoutSameFiles];
    });

    setAllFiles((prev) => {
      const nextByName = new Map(prev.map((file) => [file.name, file]));
      filesToAnalyze.forEach((file) => {
        nextByName.set(file.name, {
          name: file.name,
          status: 'pending',
          contentAvailable: userFiles.some((userFile) => userFile.name === file.name),
          restored: false,
        });
      });
      return Array.from(nextByName.values());
    });
    
     guardedAddLog({
       id: 'sys-init',
       agent: 'system',
       text: `BOOT_SEQUENCE: Initializing [${kbSettings.ragEngine.toUpperCase()}] Neural Engine in ${executionMode.toUpperCase()} mode for ${filesToAnalyze.length} uploaded document(s)...`,
      timestamp: new Date(),
      isComplete: false
    });
     if (executionMode === 'sequential') {
       await delay(180);
     }

     try {
       if (executionMode === 'sequential') {
         for (const file of filesToAnalyze) {
           if (isRunCancelled()) {
             break;
           }
           setAllFiles((prev) => prev.map((currentFile) => currentFile.name === file.name ? { ...currentFile, status: 'processing' } : currentFile));
           setUploadedFileMetadata((prev) => prev.map((metadata) => metadata.name === file.name ? { ...metadata, status: 'processing' } : metadata));
           markRuntimeBreadcrumb({
             phase: 'app-sequential-file-processing',
             runId: String(runId),
             fileName: file.name,
             details: {
               executionMode,
             },
           });
           void writeSystemLog({
             scope: 'app.ai-workflow',
             event: 'sequential-file-processing',
             message: `Sequential workflow started for ${file.name}.`,
             details: { runId, fileName: file.name },
           });

           guardedAddLog({
             id: `seq-payload-${file.name}-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
             agent: 'system',
             text: `[SEQ] PAYLOAD_RECEIVED: Processing ${file.name}`,
            timestamp: new Date(),
            isComplete: true
           });
           await delay(180);
           if (isRunCancelled()) {
             break;
           }

           try {
             const result = await runMultiAgentAnalysis(
               file.name,
               file.content,
               appConfig,
               guardedAddLog,
               guardedAddAgentExecutionEvent,
               guardedSetActiveStep,
               guardedUpsertAnalysis,
               () => guardedSetActiveStep(getPipelineFinalStep(appConfig) + 1)
             );

             if (isRunCancelled()) {
               break;
             }

             guardedUpsertAnalysis(result);
             setAllFiles((prev) => prev.map((currentFile) => currentFile.name === file.name ? { ...currentFile, status: 'complete' } : currentFile));
             setUploadedFileMetadata((prev) => prev.map((metadata) => metadata.name === file.name ? { ...metadata, status: 'complete' } : metadata));
             void writeSystemLog({
               scope: 'app.ai-workflow',
               event: 'sequential-file-complete',
               message: `Sequential workflow completed for ${file.name}.`,
               details: { runId, fileName: file.name },
             });
           } catch (error) {
             if (isRunCancelled()) {
               break;
             }

             const message = error instanceof Error ? error.message : String(error);
             void writeSystemLog({
               scope: 'app.ai-workflow',
               event: 'sequential-file-error',
               level: 'error',
               message: `Sequential workflow failed for ${file.name}.`,
               details: { runId, fileName: file.name, error },
             });
             setAllFiles((prev) => prev.map((currentFile) => currentFile.name === file.name ? { ...currentFile, status: 'error' } : currentFile));
             setUploadedFileMetadata((prev) => prev.map((metadata) => metadata.name === file.name ? { ...metadata, status: 'error' } : metadata));
             guardedAddLog({
               id: `seq-error-${file.name}-${Date.now()}`,
               agent: 'system',
               text: `EXECUTION_ERROR: ${file.name} failed - ${message}`,
              timestamp: new Date(),
              isComplete: true,
            });
             guardedAddAgentExecutionEvent({
               id: `exec-error-${file.name}-${Date.now()}`,
               documentId: file.name,
               fileName: file.name,
              agent: 'core',
              stage: 'complete',
              status: 'error',
              text: `Execution failed for ${file.name}: ${message}`,
              timestamp: new Date(),
            });
          }
         }
       } else {
         guardedAddLog({
           id: 'par-start',
           agent: 'system',
           text: `[MASS_EXECUTE] Distributing uploaded documents across the parallel multi-agent pipeline...`,
          timestamp: new Date(),
          isComplete: true
        });

         setAllFiles((prev) => {
          const nextByName = new Map(prev.map((file) => [file.name, file]));
          filesToAnalyze.forEach((file) => {
            nextByName.set(file.name, {
              name: file.name,
              status: 'processing',
              contentAvailable: true,
              restored: false,
            });
          });
          return Array.from(nextByName.values());
        });
         setUploadedFileMetadata((prev) => prev.map((metadata) => (
          userFiles.some((file) => file.name === metadata.name)
            ? { ...metadata, status: 'processing' }
            : metadata
         )));
         markRuntimeBreadcrumb({
           phase: 'app-parallel-files-processing',
           runId: String(runId),
           details: {
             executionMode,
             files: filesToAnalyze.map((file) => file.name),
           },
         });
         void writeSystemLog({
           scope: 'app.ai-workflow',
           event: 'parallel-files-processing',
           message: `Parallel workflow started for ${filesToAnalyze.length} file(s).`,
           details: { runId, files: filesToAnalyze.map((file) => file.name) },
         });

         const settledResults = await Promise.allSettled(
           filesToAnalyze.map(async (file) => {
             const result = await runParallelMultiAgentAnalysis(
               file.name,
               file.content,
               appConfig,
               guardedAddLog,
               guardedAddAgentExecutionEvent,
               (step) => guardedSetActiveStep(step),
               guardedUpsertAnalysis,
               () => {}
             );

             if (isRunCancelled()) {
               return result;
             }
             setAllFiles((prev) => prev.map((currentFile) => currentFile.name === file.name ? { ...currentFile, status: 'complete' } : currentFile));
             setUploadedFileMetadata((prev) => prev.map((metadata) => metadata.name === file.name ? { ...metadata, status: 'complete' } : metadata));
             void writeSystemLog({
               scope: 'app.ai-workflow',
               event: 'parallel-file-complete',
               message: `Parallel workflow completed for ${file.name}.`,
               details: { runId, fileName: file.name },
             });
             return result;
           }),
         );

         if (isRunCancelled()) {
           return;
         }

         const successfulResults: DocumentAnalysis[] = [];
         settledResults.forEach((result, index) => {
          const file = filesToAnalyze[index];
          if (result.status === 'fulfilled') {
            successfulResults.push(result.value);
            return;
          }

         const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
          void writeSystemLog({
            scope: 'app.ai-workflow',
            event: 'parallel-file-error',
            level: 'error',
            message: `Parallel workflow failed for ${file.name}.`,
            details: { runId, fileName: file.name, error: result.reason },
          });
          setAllFiles((prev) => prev.map((currentFile) => currentFile.name === file.name ? { ...currentFile, status: 'error' } : currentFile));
          setUploadedFileMetadata((prev) => prev.map((metadata) => metadata.name === file.name ? { ...metadata, status: 'error' } : metadata));
           guardedAddLog({
             id: `par-error-${file.name}-${Date.now()}`,
             agent: 'system',
             text: `EXECUTION_ERROR: ${file.name} failed - ${message}`,
            timestamp: new Date(),
            isComplete: true,
          });
           guardedAddAgentExecutionEvent({
             id: `par-exec-error-${file.name}-${Date.now()}`,
             documentId: file.name,
             fileName: file.name,
            agent: 'core',
            stage: 'complete',
            status: 'error',
            text: `Execution failed for ${file.name}: ${message}`,
            timestamp: new Date(),
          });
        });

         setAnalyses(successfulResults);
         guardedSetActiveStep(getPipelineFinalStep(appConfig) + 1);
       }

       if (isRunCancelled()) {
         return;
       }

       guardedAddLog({
         id: 'sys-end',
         agent: 'system',
         text: `COMPLIANCE_RUN_COMPLETE: [${executionMode.toUpperCase()}] flow verification finalized.`,
        timestamp: new Date(),
        isComplete: true
       });
       void writeSystemLog({
         scope: 'app.ai-workflow',
         event: 'analysis-run-complete',
         message: `${executionMode} AI analysis run completed.`,
         details: { runId, executionMode },
       });
     } finally {
       if (activeRunRef.current.id === runId) {
         setIsProcessing(false);
         clearRuntimeBreadcrumb('idle');
       }
     }
    }, [addAgentExecutionEvent, addLog, appConfig, executionMode, getPipelineFinalStep, isProcessing, kbSettings.ragEngine, upsertAnalysisReplacingPlaceholders, uploadedFileMetadata.length]);


  const handleStartAnalysis = async () => {
    await runAnalysisForFiles(uploadedFiles, { preserveUiState: true });
  };

  const extractVisionCapture = useCallback(async (file: File): Promise<VisionPreparedCapture> => {
    if (!file) {
      throw new Error('Vision capture did not provide a file to process.');
    }

    setCaptureAnnouncement(
      "Image captured. I'm extracting the text and preparing this page for CATOG now.",
    );

    addLog({
      id: `vision-capture-${Date.now()}`,
      agent: 'system',
      text: `VISION_CAPTURE: Reading ${file.name} and preparing CATOG intake.`,
      timestamp: new Date(),
      isComplete: true,
    });

    try {
      const visionResult = await analyzeVisionCapture(file, appConfig);
      registerPreparedFiles(
        [{
          name: visionResult.suggestedFileName,
          content: visionResult.synthesizedContent,
        }],
        {
          logPrefix: 'VISION_CAPTURE_READY',
          summary: visionResult.summary,
          citations: visionResult.citations,
        },
      );

      return {
        sourceFileName: file.name,
        name: visionResult.suggestedFileName,
        content: visionResult.synthesizedContent,
        summary: visionResult.summary,
        citations: visionResult.citations,
      };
    } catch (error) {
      addLog({
        id: `vision-capture-error-${Date.now()}`,
        agent: 'system',
        text: `VISION_CAPTURE_ERROR: ${error instanceof Error ? error.message : String(error)}`,
        timestamp: new Date(),
        isComplete: true,
      });
      throw error;
    }
  }, [addLog, appConfig, registerPreparedFiles]);

  const handleVisionBatchAnalysis = useCallback(async (captures: VisionPreparedCapture[]) => {
    // Always ensure the vision modal is closed once we have captures to process.
    setIsVisionCaptureOpen(false);

    if (captures.length === 0 || isProcessing) {
      return;
    }

    addLog({
      id: `vision-batch-ready-${Date.now()}`,
      agent: 'system',
      text: `VISION_BATCH_COLLECTED: ${captures.length} document(s) extracted. Starting CATOG analysis immediately.`,
      timestamp: new Date(),
      isComplete: true,
    });

    setCaptureAnnouncement(
      captures.length === 1
        ? "Vision intake is complete. Starting analysis now."
        : `Vision intake collected ${captures.length} files. Starting batch analysis now.`,
    );

    // Trigger analysis immediately
    void runAnalysisForFiles(
      captures.map((capture) => ({
        name: capture.name,
        content: capture.content,
      })),
      { preserveUiState: true },
    );
  }, [addLog, isProcessing, runAnalysisForFiles]);


  return (
    <div className="grid-container grid grid-cols-1 md:grid-cols-4 grid-rows-[60px_1fr] gap-[12px] p-[12px] h-screen bg-dark-grey text-[#F2F2F2]">
      {/* Header Panel */}
      <header className="col-span-1 md:col-span-4 bg-panel-bg border border-border-grey rounded-lg flex items-center justify-between px-5">
        <div className="flex items-center space-x-3">
          <ShieldCheck size={20} className="text-neon-blue" />
          <h1 className="text-base font-semibold tracking-tight uppercase">
            CATOG INTELLIGENT ENTERPRISE SOLUTION
          </h1>
        </div>

        <div className="flex items-center space-x-6">
          <div className="flex items-center space-x-4">
            {/* Upload Button */}
            <input 
              type="file" 
              className="hidden" 
              ref={fileInputRef} 
              onChange={handleFileUpload} 
              multiple
            />
            <button 
              onClick={() => fileInputRef.current?.click()}
              className="px-3 py-1.5 bg-white border border-white text-black font-bold uppercase text-[10px] tracking-widest rounded hover:bg-neon-cyan hover:border-neon-cyan transition-all flex items-center gap-2"
            >
              <Upload size={14} />
              Upload Files
            </button>
            <button
              onClick={() => setIsVisionCaptureOpen(true)}
              disabled={isProcessing}
              className={`px-3 py-1.5 font-bold uppercase text-[10px] tracking-widest rounded transition-all flex items-center gap-2 ${
                isProcessing
                  ? 'bg-white/5 border border-white/10 text-white/20 cursor-not-allowed'
                  : 'bg-neon-pink border border-neon-pink text-white hover:brightness-110'
              }`}
            >
              <Camera size={14} />
              Vision Intake
            </button>

            {/* Configuration Dropdown */}
            <button 
              onClick={() => setIsConfigOpen(true)}
              className="px-3 py-1.5 bg-neon-blue border border-neon-blue text-black font-black uppercase text-[10px] tracking-widest rounded hover:brightness-110 transition-all flex items-center gap-2"
            >
              <Layers size={14} />
              Configuration
            </button>

            {/* Execute Section */}
            <div className="flex items-center space-x-2 relative">
              <div className="flex">
                <button 
                  onClick={isProcessing ? handleStopProcessing : handleStartAnalysis}
                  className={`flex items-center space-x-2 px-6 py-1.5 rounded-l transition-all ${
                    isProcessing
                      ? 'bg-error-red/15 border border-error-red/40 text-error-red shadow-[0_0_15px_rgba(255,59,92,0.25)] hover:bg-error-red/25'
                      : 'bg-neon-cyan border-y border-l border-neon-cyan text-black font-bold shadow-[0_0_15px_rgba(0,255,136,0.3)] hover:brightness-110 active:scale-95'
                  }`}
                >
                  {isProcessing ? <Square size={14} /> : <Play size={14} />}
                  <span className="uppercase text-[11px] font-black tracking-widest">{isProcessing ? 'STOP PROCESSING' : 'EXECUTE'}</span>
                </button>
              <button
                onClick={() => !isProcessing && setShowModeMenu(!showModeMenu)}
                disabled={isProcessing}
                className={`flex items-center justify-center px-2 py-1.5 rounded-r border-y border-r transition-all ${isProcessing ? 'bg-neon-cyan/40 border-neon-cyan/20 text-black/30' : 'bg-neon-cyan border-neon-cyan text-black hover:brightness-110'}`}
              >
                <ChevronDown size={14} />
              </button>
            </div>

            {/* Execution Mode Dropdown */}
            {showModeMenu && (
              <motion.div 
                initial={{ opacity: 0, y: 10, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                className="absolute top-full right-0 mt-2 w-56 bg-panel-bg border border-white/10 rounded-lg shadow-2xl z-50 overflow-hidden"
              >
                <div className="p-2 space-y-1">
                  <button 
                    onClick={() => { setExecutionMode('sequential'); setShowModeMenu(false); }}
                    className={`w-full flex items-center space-x-3 p-3 rounded text-left transition-all ${executionMode === 'sequential' ? 'bg-white/10 text-white' : 'text-white/40 hover:bg-white/5 hover:text-white/80'}`}
                  >
                    <Repeat size={14} className={executionMode === 'sequential' ? 'text-neon-pink' : ''} />
                    <div className="flex flex-col">
                      <span className="text-[10px] font-black uppercase tracking-widest">Sequential Task</span>
                      <span className="text-[8px] opacity-60">Step-by-step agent workflow</span>
                    </div>
                  </button>
                  <button 
                    onClick={() => { setExecutionMode('parallel'); setShowModeMenu(false); }}
                    className={`w-full flex items-center space-x-3 p-3 rounded text-left transition-all ${executionMode === 'parallel' ? 'bg-white/10 text-white' : 'text-white/40 hover:bg-white/5 hover:text-white/80'}`}
                  >
                    <Layers size={14} className={executionMode === 'parallel' ? 'text-neon-cyan' : ''} />
                    <div className="flex flex-col">
                      <span className="text-[10px] font-black uppercase tracking-widest">Multi-Agent Task</span>
                      <span className="text-[8px] opacity-60">Parallelized high-speed execution</span>
                    </div>
                  </button>
                </div>
                <div className="p-2 border-t border-white/5 bg-black/40">
                  <div className="flex items-center justify-between px-1">
                    <span className="text-[8px] uppercase font-bold text-white/20 tracking-widest">Active Mode</span>
                    <span className="text-[8px] uppercase font-bold text-neon-blue tracking-widest">{executionMode}</span>
                  </div>
                </div>
              </motion.div>
            )}
          </div>
          </div>
        </div>
      </header>

      {/* Diagram Panel */}
      <div className="panel-container">
        <div className="panel-header">System Architecture Diagram</div>
        <div className="flex-1 overflow-hidden">
          <Diagram 
            activeStep={activeStep} 
            files={allFiles} 
            onGraphClick={() => setIsGraphOpen(true)}
            onViewFiles={() => setIsFileBrowserOpen(true)}
            config={appConfig}
            executionMode={executionMode}
          />
        </div>
      </div>

      {/* Terminal Panel */}
      <div className="panel-container">
        <div className="panel-header flex items-center justify-between">
          <span>System Interface &amp; Agent Comm</span>
          <button
            onClick={() => setIsHistoryOpen(true)}
            className="flex items-center gap-1.5 px-2 py-0.5 rounded text-[9px] font-black uppercase tracking-widest text-white border border-white/20 hover:bg-white/10 transition-all"
          >
            <History size={10} />
            <span>History</span>
            {analyses.length > 0 && (
              <span className="ml-0.5 px-1 rounded-full bg-white/15 text-white text-[8px]">
                {analyses.length}
              </span>
            )}
          </button>
        </div>
        <div className="flex-1 flex flex-col overflow-hidden">
          <Terminal messages={messages} config={appConfig} />
        </div>
      </div>

      {/* Results Panel */}
      <div className="panel-container relative">
        <div className="panel-header flex items-center justify-between">
          <span>Analysis & Corrections</span>
          
          <div className="flex items-center gap-2">
              <button
                onClick={handleClearWorkspaceDocuments}
                disabled={isProcessing || !hasSessionDocuments}
                className={`flex items-center space-x-2 px-2 py-0.5 rounded text-[9px] font-black tracking-widest transition-all ${
                  isProcessing || !hasSessionDocuments
                    ? 'bg-white/5 text-white/20 cursor-not-allowed'
                    : 'bg-error-red/10 text-error-red border border-error-red/25 hover:bg-error-red/20'
                }`}
              >
                <Trash2 size={10} />
                <span>CLEAR ALL</span>
              </button>
              <button
                onClick={() => {
                  if (analyses.length === 0) return;
                  setApplyFixesAnalysisId(null);
                  setIsApplyFixesOpen(true);
                }}
                disabled={analyses.length === 0}
                className={`flex items-center space-x-2 px-2 py-0.5 rounded text-[9px] font-black tracking-widest transition-all ${analyses.length === 0 ? 'bg-white/5 text-white/20 cursor-not-allowed' : 'bg-success-green text-black hover:brightness-110 active:scale-95'}`}
              >
              <FileText size={10} />
              <span>APPLY FIXES</span>
            </button>
          <div className="relative">
            <button 
              onClick={() => analyses.length > 0 && setShowReportMenu(!showReportMenu)}
              disabled={analyses.length === 0}
              className={`flex items-center space-x-2 px-2 py-0.5 rounded text-[9px] font-black tracking-widest transition-all ${analyses.length === 0 ? 'bg-white/5 text-white/20 cursor-not-allowed' : 'bg-neon-yellow text-black hover:brightness-110 active:scale-95'}`}
            >
              <Download size={10} />
              <span>GENERATE REPORT</span>
            </button>

            {showReportMenu && (
              <motion.div 
                initial={{ opacity: 0, y: 10, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                className="absolute top-full right-0 mt-2 w-36 bg-panel-bg border border-white/10 rounded-lg shadow-2xl z-50 overflow-hidden"
              >
                <div className="p-1">
                  <button 
                    onClick={() => { generateConsolidatedTxtReport(analyses); setShowReportMenu(false); }}
                    className="w-full flex items-center space-x-2 p-2 rounded text-left text-[9px] font-bold uppercase tracking-wider text-white/60 hover:bg-white/5 hover:text-neon-yellow transition-all"
                  >
                    <FileText size={12} />
                    <span>TEXT (.txt)</span>
                  </button>
                  <button 
                    onClick={() => { generateConsolidatedDocxReport(analyses); setShowReportMenu(false); }}
                    className="w-full flex items-center space-x-2 p-2 rounded text-left text-[9px] font-bold uppercase tracking-wider text-white/60 hover:bg-white/5 hover:text-neon-yellow transition-all"
                  >
                    <FileIcon size={12} />
                    <span>WORD (.docx)</span>
                  </button>
                  <button 
                    onClick={() => { generateConsolidatedPdfReport(analyses); setShowReportMenu(false); }}
                    className="w-full flex items-center space-x-2 p-2 rounded text-left text-[9px] font-bold uppercase tracking-wider text-white/60 hover:bg-white/5 hover:text-neon-yellow transition-all"
                  >
                    <FileIcon size={12} className="text-error-red" />
                    <span>PDF (.pdf)</span>
                  </button>
                </div>
              </motion.div>
            )}
          </div>
          </div>
        </div>
        <div className="flex-1 overflow-hidden">
          <AnalysisResults 
            analyses={analyses} 
            onSelect={(doc) => setSelectedDoc(doc)} 
          />
        </div>

        {/* Correction Sync overlay — appears only after all specialists finish their reviews */}
        {isProcessing && allSpecialistsComplete && (
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="absolute bottom-5 right-5 w-80 bg-dark-grey border border-neon-blue rounded-lg shadow-2xl p-4 z-20"
          >
            <div className="text-neon-blue text-[11px] font-bold uppercase mb-2 tracking-widest">Correction Sync Active</div>
            <div className="text-[12px] leading-relaxed space-y-1">
              <div>
                <span className="text-white/40">Injecting findings for:</span>{' '}
                <span className="text-neon-blue">{analyses[0]?.fileName ?? 'document'}</span>
              </div>
              <div>
                <span className="text-white/40">Status:</span>{' '}
                <span className="text-neon-yellow">Mapping Gaps...</span>
              </div>
              {analyses[0] && (
                <div>
                  <span className="text-white/40">Findings:</span>{' '}
                  <span className="text-success-green">{analyses[0].findings.length} detected</span>
                  <span className="text-white/20 mx-1">·</span>
                  <span className="text-neon-pink">{analyses[0].corrections.length} corrections</span>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </div>

      {/* Agent Chat Panel (New 4th Column) */}
      <div className="panel-container">
        <div className="panel-header">Agent Communication Sync</div>
        <div className="flex-1 overflow-hidden">
          <AgentChat
            analyses={analyses}
            config={appConfig}
            executionMessages={agentExecutionMessages}
            isProcessing={isProcessing}
            onOpenVisionCapture={() => setIsVisionCaptureOpen(true)}
            captureAnnouncement={captureAnnouncement}
            onCaptureAnnouncementConsumed={() => setCaptureAnnouncement(null)}
          />
        </div>
      </div>


      {/* Detail Modal */}
      <DocumentModal
        doc={selectedDoc}
        onClose={() => setSelectedDoc(null)}
        onApplyFixes={(analysis) => {
          setApplyFixesAnalysisId(analysis.id);
          setSelectedDoc(null);
          setIsApplyFixesOpen(true);
        }}
      />

      {/* Workflow History Modal */}
      <WorkflowHistoryModal
        isOpen={isHistoryOpen}
        onClose={() => setIsHistoryOpen(false)}
        analyses={analyses}
        onSelect={(analysis) => {
          setSelectedDoc(analysis);
          setIsHistoryOpen(false);
        }}
        onDelete={deleteAnalysis}
      />

      {/* Apply Fixes Modal */}
      <ApplyFixesModal
        isOpen={isApplyFixesOpen}
        onClose={() => {
          setIsApplyFixesOpen(false);
          setApplyFixesAnalysisId(null);
        }}
        analyses={analyses}
        uploadedFiles={uploadedFiles}
        initialAnalysisId={applyFixesAnalysisId}
      />
      
      {/* File Browser Modal */}
      <FileBrowserModal 
        isOpen={isFileBrowserOpen} 
        onClose={() => setIsFileBrowserOpen(false)} 
        files={allFiles} 
      />

      {/* Knowledge Graph Modal */}
      <KnowledgeGraphModal 
        isOpen={isGraphOpen} 
        onClose={() => setIsGraphOpen(false)} 
        config={appConfig} 
      />

      {/* System Configuration Modal */}
      <ConfigurationModal 
         isOpen={isConfigOpen}
         onClose={() => setIsConfigOpen(false)}
         config={appConfig}
         initialTab={configTab}
        onSave={(newConfig) => {
          setAppConfig(newConfig);
          const persistenceError = persistAppConfig(newConfig);
          addLog({
            id: `config-update-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
            agent: 'system',
            text: persistenceError
              ? `CONFIG_SAVE_WARNING: ${persistenceError}`
              : 'Global System Configuration successfully updated and persisted locally. All agents re-initialized.',
            timestamp: new Date(),
            isComplete: true,
          });
        }}
      />

      <VisionCaptureModal
        isOpen={isVisionCaptureOpen}
        isBusy={isProcessing}
        detectorModel={appConfig.vision.detectorModel}
        onClose={() => setIsVisionCaptureOpen(false)}
        onExtractCapture={extractVisionCapture}
        onAnalyzeBatch={handleVisionBatchAnalysis}
      />

    </div>
  );
}
