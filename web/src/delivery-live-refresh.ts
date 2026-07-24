type TimerHandle = any;

export interface DeliveryEventSource {
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  addEventListener(type: "delivery-change", listener: () => void): void;
  close(): void;
}

export function subscribeDeliveryLiveRefresh(input: {
  requirementId: string;
  refresh: () => Promise<void>;
  createEventSource?: (url: string) => DeliveryEventSource;
  setInterval?: (callback: () => void, delay: number) => TimerHandle;
  clearInterval?: (handle: TimerHandle) => void;
  fallbackMs?: number;
}) {
  const createSource = input.createEventSource
    ?? ((url: string) => new EventSource(url) as unknown as DeliveryEventSource);
  const schedule = input.setInterval ?? globalThis.setInterval;
  const cancel = input.clearInterval ?? globalThis.clearInterval;
  let active = true;
  let source: DeliveryEventSource | null = null;
  let fallbackTimer: TimerHandle | null = null;
  let refreshing = false;
  let refreshPending = false;
  let pollBeforeReconnect = false;

  const refresh = async () => {
    if (!active) return;
    if (refreshing) {
      refreshPending = true;
      return;
    }
    refreshing = true;
    try {
      await input.refresh();
    } catch {
      // A later SSE event or fallback tick retries the authoritative refresh.
    } finally {
      refreshing = false;
      if (active && refreshPending) {
        refreshPending = false;
        void refresh();
      }
    }
  };

  const clearFallback = () => {
    if (fallbackTimer === null) return;
    cancel(fallbackTimer);
    fallbackTimer = null;
  };

  const connect = () => {
    if (!active || source) return;
    const next = createSource(`/api/requirements/${encodeURIComponent(input.requirementId)}/delivery-events`);
    source = next;
    next.addEventListener("delivery-change", () => { if (active && source === next) void refresh(); });
    next.onopen = () => {
      if (!active || source !== next) return;
      pollBeforeReconnect = false;
      clearFallback();
    };
    next.onerror = () => {
      if (!active || source !== next) return;
      next.close();
      source = null;
      if (fallbackTimer !== null) return;
      fallbackTimer = schedule(() => {
        if (!active) return;
        if (source) {
          pollBeforeReconnect = false;
          void refresh();
        } else if (pollBeforeReconnect) {
          pollBeforeReconnect = false;
          void refresh();
        } else {
          connect();
          pollBeforeReconnect = true;
        }
      }, input.fallbackMs ?? 2_000);
    };
  };

  connect();
  return () => {
    if (!active) return;
    active = false;
    clearFallback();
    source?.close();
    source = null;
  };
}
