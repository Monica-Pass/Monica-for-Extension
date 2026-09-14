/** A trusted extension-page port carries invalidation only, never vault contents. */
export function connectLiveVault(refresh: () => Promise<void>, onError: (error: unknown) => void = () => undefined): () => void {
  let port: chrome.runtime.Port | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let running = false;
  let dirty = false;
  let lastActivity = 0;

  function post(message: object): void {
    try { port?.postMessage(message); } catch { /* Worker suspension is handled by onDisconnect. */ }
  }
  function invalidate(): void {
    dirty = true;
    if (stopped || running || document.hidden || refreshTimer !== undefined) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      if (stopped || document.hidden) return;
      dirty = false;
      running = true;
      void refresh().catch(onError).finally(() => {
        running = false;
        if (dirty && !stopped) invalidate();
      });
    }, 100);
  }
  function connect(): void {
    if (stopped) return;
    try {
      const connected = chrome.runtime.connect({ name: "monica-vault-live-v1" });
      port = connected;
      connected.onMessage.addListener(message => { if (message?.type === "vault-changed") invalidate(); });
      connected.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        if (port !== connected || stopped) return;
        port = undefined;
        dirty = true;
        reconnectTimer = setTimeout(connect, 2000);
      });
      post({ type: "visibility", visible: !document.hidden });
      if (dirty) invalidate();
    } catch {
      reconnectTimer = setTimeout(connect, 5000);
    }
  }
  function visibility(): void {
    post({ type: "visibility", visible: !document.hidden });
    if (!document.hidden) invalidate();
  }
  function focus(): void {
    if (!document.hidden) { post({ type: "focus" }); invalidate(); }
  }
  function online(): void { post({ type: "online" }); invalidate(); }
  function activity(event: Event): void {
    if (!event.isTrusted || document.hidden || Date.now() - lastActivity < 10_000) return;
    lastActivity = Date.now();
    post({ type: "activity" });
  }

  connect();
  document.addEventListener("visibilitychange", visibility);
  document.addEventListener("pointerdown", activity, true);
  document.addEventListener("keydown", activity, true);
  window.addEventListener("focus", focus);
  window.addEventListener("online", online);
  return () => {
    stopped = true;
    if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
    if (refreshTimer !== undefined) clearTimeout(refreshTimer);
    port?.disconnect();
    document.removeEventListener("visibilitychange", visibility);
    document.removeEventListener("pointerdown", activity, true);
    document.removeEventListener("keydown", activity, true);
    window.removeEventListener("focus", focus);
    window.removeEventListener("online", online);
  };
}
