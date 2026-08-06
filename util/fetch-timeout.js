// Shared fetch wrapper with a hard timeout. Native fetch() has no default
// timeout — a stalled remote (connection accepted, response never sent)
// hangs the await forever, which is what wedged the screening cycle's
// _screeningBusy lock (see index.js's stale-lock safety net).
export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

export async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return fetch(url, options);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = options.signal;
  const abortFromParent = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", abortFromParent, { once: true });
  }

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", abortFromParent);
  }
}
