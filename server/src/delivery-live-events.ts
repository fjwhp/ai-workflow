import type { DatabaseSync } from "node:sqlite";

type TimerHandle = any;

export const MAX_DELIVERY_EVENT_SUBSCRIBERS = 64;
export const MAX_DELIVERY_EVENT_SUBSCRIBERS_PER_REQUIREMENT = 8;

export function deliveryEventGeneration(db: DatabaseSync, requirementId: string): string {
  const row = db.prepare(`SELECT generation FROM delivery_event_generations
    WHERE requirement_id = ?`).get(requirementId) as { generation: number } | undefined;
  return String(row?.generation ?? 0);
}

interface DeliveryEventHubOptions {
  generation: (requirementId: string) => string;
  setInterval?: (callback: () => void, delay: number) => TimerHandle;
  clearInterval?: (handle: TimerHandle) => void;
  intervalMs?: number;
  maxSubscribers?: number;
  maxSubscribersPerRequirement?: number;
}

interface DeliveryEventWatcher {
  current: string;
  listeners: Set<(generation: string) => void>;
  timer: TimerHandle;
}

export class DeliveryEventHub {
  private readonly watchers = new Map<string, DeliveryEventWatcher>();
  private readonly schedule: (callback: () => void, delay: number) => TimerHandle;
  private readonly cancel: (handle: TimerHandle) => void;
  private readonly intervalMs: number;
  private readonly maxSubscribers: number;
  private readonly maxSubscribersPerRequirement: number;
  private subscriberCount = 0;
  private closed = false;

  constructor(private readonly options: DeliveryEventHubOptions) {
    this.schedule = options.setInterval ?? globalThis.setInterval;
    this.cancel = options.clearInterval ?? globalThis.clearInterval;
    this.intervalMs = options.intervalMs ?? 500;
    this.maxSubscribers = options.maxSubscribers ?? MAX_DELIVERY_EVENT_SUBSCRIBERS;
    this.maxSubscribersPerRequirement = options.maxSubscribersPerRequirement
      ?? MAX_DELIVERY_EVENT_SUBSCRIBERS_PER_REQUIREMENT;
  }

  subscribe(requirementId: string, listener: (generation: string) => void) {
    if (this.closed) throw new Error("DELIVERY_EVENT_HUB_CLOSED");
    if (this.subscriberCount >= this.maxSubscribers) throw new Error("DELIVERY_EVENT_GLOBAL_LIMIT");
    let watcher = this.watchers.get(requirementId);
    if (watcher && watcher.listeners.size >= this.maxSubscribersPerRequirement) {
      throw new Error("DELIVERY_EVENT_REQUIREMENT_LIMIT");
    }
    if (!watcher) {
      if (this.maxSubscribersPerRequirement < 1) throw new Error("DELIVERY_EVENT_REQUIREMENT_LIMIT");
      const created: DeliveryEventWatcher = {
        current: this.options.generation(requirementId),
        listeners: new Set(),
        timer: undefined
      };
      created.timer = this.schedule(() => this.poll(requirementId, created), this.intervalMs);
      watcher = created;
      this.watchers.set(requirementId, watcher);
    }
    watcher.listeners.add(listener);
    this.subscriberCount += 1;
    let active = true;
    return {
      initialGeneration: watcher.current,
      close: () => {
        if (!active) return;
        active = false;
        const current = this.watchers.get(requirementId);
        if (!current || !current.listeners.delete(listener)) return;
        this.subscriberCount -= 1;
        if (current.listeners.size > 0) return;
        this.cancel(current.timer);
        this.watchers.delete(requirementId);
      }
    };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const watcher of this.watchers.values()) this.cancel(watcher.timer);
    this.watchers.clear();
    this.subscriberCount = 0;
  }

  private poll(requirementId: string, watcher: DeliveryEventWatcher) {
    if (this.closed || this.watchers.get(requirementId) !== watcher) return;
    const next = this.options.generation(requirementId);
    if (next === watcher.current) return;
    watcher.current = next;
    for (const listener of [...watcher.listeners]) listener(next);
  }
}

interface DeliveryEventWritable {
  write(chunk: string): boolean;
  once(event: "drain", listener: () => void): unknown;
  off(event: "drain", listener: () => void): unknown;
}

export function createDeliveryEventWriter(response: DeliveryEventWritable) {
  let closed = false;
  let blocked = false;
  let drainAttached = false;
  let pending: string | null = null;

  const onDrain = () => {
    drainAttached = false;
    if (closed) return;
    blocked = false;
    const latest = pending;
    pending = null;
    if (latest !== null) write(latest);
  };
  const write = (generation: string) => {
    if (closed) return;
    if (blocked) {
      pending = generation;
      return;
    }
    if (response.write(formatDeliveryEvent(generation))) return;
    blocked = true;
    if (!drainAttached) {
      drainAttached = true;
      response.once("drain", onDrain);
    }
  };
  return {
    emit: write,
    close: () => {
      if (closed) return;
      closed = true;
      pending = null;
      if (drainAttached) response.off("drain", onDrain);
      drainAttached = false;
    }
  };
}

function formatDeliveryEvent(generation: string) {
  return `event: delivery-change\ndata: ${JSON.stringify({ generation })}\n\n`;
}
