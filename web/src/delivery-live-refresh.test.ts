import { describe, expect, it } from "vitest";
import { DetailRequestTracker } from "./detail-requests.js";

class FakeEventSource {
  readonly listeners = new Map<string, Array<() => void>>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  addEventListener(type: string, listener: () => void) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  emit(type: string) { for (const listener of this.listeners.get(type) ?? []) listener(); }
  close() { this.closed = true; }
}

describe("delivery live refresh", () => {
  it("refreshes on SSE, falls back to polling, reconnects, and cleans up old subscriptions", async () => {
    const module = await import("./delivery-live-refresh.js").catch(() => ({}));
    const subscribeDeliveryLiveRefresh = (module as any).subscribeDeliveryLiveRefresh;
    expect(subscribeDeliveryLiveRefresh).toBeTypeOf("function");
    if (!subscribeDeliveryLiveRefresh) return;
    const sources: Array<{ url: string; source: FakeEventSource }> = [];
    const intervals = new Map<number, () => void>();
    let nextInterval = 1;
    let refreshes = 0;
    const subscribe = (requirementId: string) => subscribeDeliveryLiveRefresh({
      requirementId,
      refresh: async () => { refreshes += 1; },
      createEventSource: (url: string) => {
        const source = new FakeEventSource();
        sources.push({ url, source });
        return source;
      },
      setInterval: (callback: () => void, delay: number) => {
        expect(delay).toBe(2_000);
        const id = nextInterval++;
        intervals.set(id, callback);
        return id;
      },
      clearInterval: (id: number) => { intervals.delete(id); }
    });

    const disposeA = subscribe("requirement-a");
    expect(sources[0]?.url).toBe("/api/requirements/requirement-a/delivery-events");
    sources[0]!.source.emit("delivery-change");
    await Promise.resolve();
    expect(refreshes).toBe(1);
    sources[0]!.source.onerror?.();
    expect(sources[0]!.source.closed).toBe(true);
    expect(intervals.size).toBe(1);
    intervals.values().next().value?.();
    await Promise.resolve();
    expect(refreshes).toBe(1);
    expect(sources).toHaveLength(2);
    sources[1]!.source.emit("delivery-change");
    await Promise.resolve();
    expect(refreshes).toBe(2);
    sources[1]!.source.onopen?.();
    expect(intervals.size).toBe(0);

    disposeA();
    expect(sources[1]!.source.closed).toBe(true);
    sources[1]!.source.emit("delivery-change");
    await Promise.resolve();
    expect(refreshes).toBe(2);
    const disposeB = subscribe("requirement-b");
    expect(sources[2]?.url).toBe("/api/requirements/requirement-b/delivery-events");
    disposeB();
  });

  it("combines subscription cleanup with request generations so an old refresh cannot replace a new detail", async () => {
    const module = await import("./delivery-live-refresh.js").catch(() => ({}));
    const subscribeDeliveryLiveRefresh = (module as any).subscribeDeliveryLiveRefresh;
    expect(subscribeDeliveryLiveRefresh).toBeTypeOf("function");
    if (!subscribeDeliveryLiveRefresh) return;
    const tracker = new DetailRequestTracker();
    let desiredId: string | null = "requirement-a";
    const accepted: string[] = [];
    const pending: Array<() => void> = [];
    const sources: FakeEventSource[] = [];
    const subscribe = (requirementId: string) => subscribeDeliveryLiveRefresh({
      requirementId,
      refresh: async () => {
        const token = tracker.begin(requirementId);
        await new Promise<void>((resolve) => pending.push(resolve));
        if (tracker.accept(token, desiredId)) accepted.push(requirementId);
      },
      createEventSource: () => { const source = new FakeEventSource(); sources.push(source); return source; },
      setInterval: () => 1,
      clearInterval: () => undefined
    });

    const disposeA = subscribe("requirement-a");
    sources[0]!.emit("delivery-change");
    disposeA();
    desiredId = "requirement-b";
    const disposeB = subscribe("requirement-b");
    sources[1]!.emit("delivery-change");
    pending[0]?.();
    pending[1]?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(accepted).toEqual(["requirement-b"]);
    disposeB();
  });
});
