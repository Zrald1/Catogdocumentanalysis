import { invoke, isTauri } from '@tauri-apps/api/core';
import { DocumentAnalysis, Obligation } from '../types';
import { ensureDocumentAnalysisGraph } from './analysisGraph';
import { writeSystemLog } from './systemLogger';

export type UploadedFileMetadata = {
  name: string;
  status: 'pending' | 'processing' | 'complete' | 'error';
};

type PersistedAnalysisHistory = {
  analyses: DocumentAnalysis[];
  uploadedFileMetadata: UploadedFileMetadata[];
};

const ANALYSIS_HISTORY_STORAGE_KEY = 'catog-analysis-history-v1';
const MAX_PERSISTED_ANALYSES = 50; // Increased since we are now using Rust/FS

const toPersistableAnalysis = (analysis: DocumentAnalysis): DocumentAnalysis => ({
  id: analysis.id,
  fileName: analysis.fileName,
  status: analysis.status,
  findings: analysis.findings,
  corrections: analysis.corrections,
  obligations: analysis.obligations,
  createdAt: analysis.createdAt,
});

const isValidObligation = (obligation: Partial<Obligation>): obligation is Obligation => (
  typeof obligation?.title === 'string'
  && typeof obligation.owner === 'string'
  && typeof obligation.dueDate === 'string'
  && (obligation.priority === 'low' || obligation.priority === 'medium' || obligation.priority === 'high')
  && (obligation.status === 'open' || obligation.status === 'in_progress' || obligation.status === 'blocked' || obligation.status === 'resolved')
  && typeof obligation.rationale === 'string'
  && typeof obligation.sourceExcerpt === 'string'
);

const normalizeStoredAnalysis = (analysis: Partial<DocumentAnalysis>): DocumentAnalysis | null => {
  if (
    typeof analysis?.id !== 'string'
    || typeof analysis.fileName !== 'string'
    || (analysis.status !== 'pending' && analysis.status !== 'analyzing' && analysis.status !== 'complete' && analysis.status !== 'error')
    || !Array.isArray(analysis.findings)
    || !Array.isArray(analysis.corrections)
  ) {
    return null;
  }

  return ensureDocumentAnalysisGraph({
    ...analysis,
    obligations: Array.isArray(analysis.obligations)
      ? analysis.obligations.filter(isValidObligation)
      : [],
  } as DocumentAnalysis);
};

export const loadPersistedAnalysisHistory = async (): Promise<{
  analyses: DocumentAnalysis[];
  uploadedFileMetadata: UploadedFileMetadata[];
  error?: string;
}> => {
  if (typeof window === 'undefined') {
    return { analyses: [], uploadedFileMetadata: [] };
  }

  let storedValue: string | null = null;
  try {
    if (isTauri()) {
      storedValue = await invoke<string>('load_analysis_history');
    } else {
      storedValue = window.localStorage.getItem(ANALYSIS_HISTORY_STORAGE_KEY);
    }
  } catch (error) {
    void writeSystemLog({
      scope: 'analysis-history',
      event: 'load-error',
      level: 'error',
      message: 'Failed to load analysis history from storage.',
      details: { error },
    });
  }

  if (!storedValue || storedValue === '{}') {
    return { analyses: [], uploadedFileMetadata: [] };
  }

  try {
    const parsedValue = JSON.parse(storedValue) as Partial<PersistedAnalysisHistory>;
    return {
      analyses: Array.isArray(parsedValue.analyses)
        ? parsedValue.analyses
          .map((analysis) => normalizeStoredAnalysis(analysis))
          .filter((analysis): analysis is DocumentAnalysis => Boolean(analysis))
        : [],
      uploadedFileMetadata: Array.isArray(parsedValue.uploadedFileMetadata)
        ? parsedValue.uploadedFileMetadata.filter(
            (file): file is UploadedFileMetadata =>
              typeof file?.name === 'string'
              && (file.status === 'pending' || file.status === 'processing' || file.status === 'complete' || file.status === 'error'),
          )
        : [],
    };
  } catch (error) {
    return {
      analyses: [],
      uploadedFileMetadata: [],
      error: error instanceof Error
        ? `Stored analysis history could not be restored: ${error.message}`
        : 'Stored analysis history could not be restored.',
    };
  }
};

export const persistAnalysisHistory = (
  analyses: DocumentAnalysis[],
  uploadedFileMetadata: UploadedFileMetadata[],
): string | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const persistableAnalyses = analyses
      .slice(0, MAX_PERSISTED_ANALYSES)
      .map(toPersistableAnalysis);
    const payload = {
      analyses: persistableAnalyses,
      uploadedFileMetadata,
    } satisfies PersistedAnalysisHistory;

    const payloadString = JSON.stringify(payload);

    if (isTauri()) {
      // Execute as a background task to not block the UI
      void invoke('persist_analysis_history', { payload: payloadString })
        .catch((error) => {
          // eslint-disable-next-line no-console
          console.error('[catog:analysis-history] Rust persistence failed', error);
        });
    } else {
      window.localStorage.setItem(
        ANALYSIS_HISTORY_STORAGE_KEY,
        payloadString,
      );
    }

    return null;
  } catch (error) {
    void writeSystemLog({
      scope: 'analysis-history',
      event: 'persist-error',
      level: 'error',
      message: 'Analysis history persistence failed.',
      details: {
        error,
        analyses: analyses.length,
        uploadedFileMetadata: uploadedFileMetadata.length,
        graphPayloads: analyses.filter((analysis) => analysis.graph || analysis.graphIndex).length,
      },
    });
    return error instanceof Error
      ? `Analysis history persistence failed: ${error.message}`
      : 'Analysis history persistence failed.';
  }
};
