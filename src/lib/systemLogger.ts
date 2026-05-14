import { invoke, isTauri } from '@tauri-apps/api/core';

type SystemLogLevel = 'debug' | 'info' | 'warn' | 'error';

type SystemLogEntry = {
  scope: string;
  event: string;
  level?: SystemLogLevel;
  message?: string;
  details?: Record<string, unknown>;
};

export type RuntimeBreadcrumb = {
  phase: string;
  at: string;
  runId?: string;
  docId?: string;
  fileName?: string;
  details?: Record<string, unknown>;
};

const RUNTIME_BREADCRUMB_KEY = 'catog:runtime-breadcrumb';

let lastKnownSystemLogPath: string | null = null;

const serializeError = (value: unknown): unknown => {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  return value;
};

export const getLastKnownSystemLogPath = () => lastKnownSystemLogPath;

export const readRuntimeBreadcrumb = (): RuntimeBreadcrumb | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(RUNTIME_BREADCRUMB_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<RuntimeBreadcrumb>;
    return typeof parsed.phase === 'string' && typeof parsed.at === 'string'
      ? parsed as RuntimeBreadcrumb
      : null;
  } catch {
    return null;
  }
};

export const markRuntimeBreadcrumb = (breadcrumb: Omit<RuntimeBreadcrumb, 'at'>): void => {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(
      RUNTIME_BREADCRUMB_KEY,
      JSON.stringify({
        ...breadcrumb,
        at: new Date().toISOString(),
      } satisfies RuntimeBreadcrumb),
    );
  } catch {
    // Breadcrumbs are best-effort and must not interrupt the analysis flow.
  }
};

export const clearRuntimeBreadcrumb = (phase = 'idle'): void => {
  markRuntimeBreadcrumb({ phase });
};

export const getSystemLogPath = async (): Promise<string | null> => {
  if (!isTauri()) {
    return null;
  }

  try {
    lastKnownSystemLogPath = await invoke<string>('get_system_log_path');
    return lastKnownSystemLogPath;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('[catog:system-log] failed to resolve systemlogs.txt path', error);
    return null;
  }
};

export const openSystemLog = async (): Promise<string | null> => {
  if (!isTauri()) {
    return null;
  }

  try {
    lastKnownSystemLogPath = await invoke<string>('open_system_log');
    return lastKnownSystemLogPath;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('[catog:system-log] failed to open systemlogs.txt', error);
    return null;
  }
};

export const readSystemLog = async (): Promise<string> => {
  if (!isTauri()) {
    return 'System logs are only available in the native desktop environment.';
  }

  try {
    return await invoke<string>('read_system_log');
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('[catog:system-log] failed to read systemlogs.txt', error);
    return `ERROR: Failed to read system logs. ${error instanceof Error ? error.message : String(error)}`;
  }
};

export const writeSystemLog = async ({
  scope,
  event,
  level = 'info',
  message,
  details,
}: SystemLogEntry): Promise<void> => {
  const payload = {
    at: new Date().toISOString(),
    level,
    scope,
    event,
    message,
    details: details
      ? Object.fromEntries(Object.entries(details).map(([key, value]) => [key, serializeError(value)]))
      : undefined,
  };

  const line = JSON.stringify(payload);
  // Keep a console copy because it survives enough in devtools to compare with
  // systemlogs.txt when the WebView restarts during heavy model work.
  // eslint-disable-next-line no-console
  console.info('[catog:system-log]', payload);

  if (!isTauri()) {
    return;
  }

  try {
    lastKnownSystemLogPath = await invoke<string>('append_system_log', { entry: line });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('[catog:system-log] failed to write systemlogs.txt', error, payload);
  }
};
