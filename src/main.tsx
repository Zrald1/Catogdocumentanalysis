import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { readRuntimeBreadcrumb, writeSystemLog } from './lib/systemLogger.ts';

// --- Reload / crash diagnostics -------------------------------------------
// Several users reported the Tauri shell silently reloading while idle.
// Surface every possible reload pathway through the console + localStorage so
// the cause is visible the next time it happens (and so that uncaught errors
// no longer cascade into a full WebView reload).

// Programmatic reload hardening: Intercept any library or accidental code
// that might trigger a navigation or reload.
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (event) => {
    // Block Cmd+R / Ctrl+R / F5 reloads that might be enabled in some environments
    if (
      (event.metaKey && event.key === 'r') ||
      (event.ctrlKey && event.key === 'r') ||
      event.key === 'F5'
    ) {
      event.preventDefault();
      // eslint-disable-next-line no-console
      console.warn('[catog:reload-prevention] blocked keyboard reload shortcut:', event.key);
    }
  }, { capture: true });
}

type ReloadEvent = {
  type: string;
  reason: string;
  at: string;
};
const RELOAD_LOG_KEY = 'catog:reload-log';
const BOOT_LOG_KEY = 'catog:boot-log';
const BOOT_COUNT_KEY = 'catog:boot-count';
const recordReloadEvent = (entry: ReloadEvent) => {
  try {
    const raw = window.localStorage.getItem(RELOAD_LOG_KEY);
    const buffer = raw ? (JSON.parse(raw) as ReloadEvent[]) : [];
    buffer.push(entry);
    while (buffer.length > 25) buffer.shift();
    window.localStorage.setItem(RELOAD_LOG_KEY, JSON.stringify(buffer));
  } catch {
    // localStorage may be unavailable mid-teardown; ignore.
  }
  // eslint-disable-next-line no-console
  console.warn('[catog:reload-diagnostic]', entry);
  void writeSystemLog({
    scope: 'webview.reload-diagnostic',
    event: entry.type,
    level: entry.type === 'beforeunload' ? 'warn' : 'error',
    message: entry.reason,
    details: entry,
  });
};

const recordBootEvent = () => {
  try {
    const nextBootCount = Number(window.localStorage.getItem(BOOT_COUNT_KEY) || '0') + 1;
    window.localStorage.setItem(BOOT_COUNT_KEY, String(nextBootCount));
    const previousBreadcrumb = readRuntimeBreadcrumb();
    const bootEntry = {
      type: 'webview.boot',
      bootCount: nextBootCount,
      at: new Date().toISOString(),
      href: window.location.href,
      previousBreadcrumb,
      navigation: performance.getEntriesByType('navigation').map((entry) => {
        const navigationEntry = entry as PerformanceNavigationTiming;
        return {
          type: navigationEntry.type,
          startTime: navigationEntry.startTime,
          duration: navigationEntry.duration,
          domComplete: navigationEntry.domComplete,
        };
      }),
    };
    const raw = window.localStorage.getItem(BOOT_LOG_KEY);
    const buffer = raw ? (JSON.parse(raw) as typeof bootEntry[]) : [];
    buffer.push(bootEntry);
    while (buffer.length > 25) buffer.shift();
    window.localStorage.setItem(BOOT_LOG_KEY, JSON.stringify(buffer));
    void writeSystemLog({
      scope: 'webview.boot',
      event: 'renderer-boot',
      level: nextBootCount > 1 ? 'warn' : 'info',
      message: `Renderer boot #${nextBootCount}.`,
      details: bootEntry,
    });
  } catch {
    // Boot diagnostics are best-effort.
  }
};

recordBootEvent();

window.addEventListener('beforeunload', (event) => {
  const activeBreadcrumb = readRuntimeBreadcrumb();
  recordReloadEvent({
    type: 'beforeunload',
    reason: activeBreadcrumb && activeBreadcrumb.phase !== 'idle'
      ? `blocked-active-ai-phase=${activeBreadcrumb.phase}`
      : `returnValue=${String((event as BeforeUnloadEvent).returnValue ?? '')}`,
    at: new Date().toISOString(),
  });

  if (activeBreadcrumb && activeBreadcrumb.phase !== 'idle') {
    event.preventDefault();
    event.returnValue = 'CATOG is running an AI analysis task. Stop processing before closing or reloading.';
  }
});

window.addEventListener('pagehide', (event) => {
  const activeBreadcrumb = readRuntimeBreadcrumb();
  if (!activeBreadcrumb || activeBreadcrumb.phase === 'idle') {
    return;
  }

  recordReloadEvent({
    type: 'pagehide',
    reason: `persisted=${String(event.persisted)} active-ai-phase=${activeBreadcrumb.phase}`,
    at: new Date().toISOString(),
  });
});

window.addEventListener('error', (event) => {
  recordReloadEvent({
    type: 'window.error',
    reason: event.message || String(event.error || 'unknown error'),
    at: new Date().toISOString(),
  });
  // Swallow the bubbling default so a stray error cannot trigger WebView2
  // to navigate / reload on Windows.
  event.preventDefault?.();
});

window.addEventListener('unhandledrejection', (event) => {
  recordReloadEvent({
    type: 'unhandledrejection',
    reason: String(event.reason instanceof Error ? event.reason.message : event.reason),
    at: new Date().toISOString(),
  });
  event.preventDefault?.();
});

// Surface the previous session's reload trail to the console so the user can
// quickly see why the app last restarted.
try {
  const previousBreadcrumb = readRuntimeBreadcrumb();
  if (previousBreadcrumb && previousBreadcrumb.phase !== 'idle') {
    void writeSystemLog({
      scope: 'runtime.reload-detector',
      event: 'previous-session-ended-during-active-phase',
      level: 'warn',
      message: `Previous app session ended while phase was ${previousBreadcrumb.phase}.`,
      details: {
        breadcrumb: previousBreadcrumb,
        diagnosis: 'If this appears immediately after a WebView reload, the last successful breadcrumb is the step to inspect first.',
      },
    });
  }

  const raw = window.localStorage.getItem(RELOAD_LOG_KEY);
  if (raw) {
    // eslint-disable-next-line no-console
    console.info('[catog:reload-diagnostic] previous session events:', JSON.parse(raw));
    void writeSystemLog({
      scope: 'webview.reload-diagnostic',
      event: 'previous-session-events',
      message: 'Recovered reload diagnostic events from localStorage on startup.',
      details: { events: JSON.parse(raw) },
    });
  }

  const bootRaw = window.localStorage.getItem(BOOT_LOG_KEY);
  if (bootRaw) {
    // eslint-disable-next-line no-console
    console.info('[catog:boot-diagnostic] recent renderer boots:', JSON.parse(bootRaw));
  }
} catch {
  // ignore
}
// --------------------------------------------------------------------------

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
