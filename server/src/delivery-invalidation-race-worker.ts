import { parentPort, threadId } from "node:worker_threads";
import { WorkflowStore } from "./store.js";
import type { DeliveryExecutionClaim, DeliveryExecutionSuccess } from "./delivery-execution-repository.js";
import type { DeliveryQualityClaim, DeliveryQualityCompletion } from "./delivery-quality-repository.js";

if (!parentPort) throw new Error("DELIVERY_INVALIDATION_RACE_PARENT_REQUIRED");

type RaceMessage = {
  type: "prepare";
  iteration: number;
  databasePath: string;
  barrier: SharedArrayBuffer;
  operation:
    | { kind: "implementation"; claim: DeliveryExecutionClaim; completion: DeliveryExecutionSuccess }
    | { kind: "quality"; claim: DeliveryQualityClaim; completion: DeliveryQualityCompletion }
    | { kind: "pause"; input: { requirementId: string; actor: string; reason: string } }
    | { kind: "lease"; workerId: string; now: string; leaseMs: number };
};

parentPort.on("message", (message: RaceMessage) => {
  if (message.type !== "prepare") return;
  const store = new WorkflowStore(message.databasePath);
  const barrier = new Int32Array(message.barrier);
  Atomics.add(barrier, 0, 1);
  Atomics.notify(barrier, 0);
  parentPort!.postMessage({ type: "ready", iteration: message.iteration, threadId });
  while (Atomics.load(barrier, 1) === 0) Atomics.wait(barrier, 1, 0);
  const callers = Atomics.add(barrier, 2, 1) + 1;
  Atomics.notify(barrier, 2);
  if (callers < 2) while (Atomics.load(barrier, 2) < 2) Atomics.wait(barrier, 2, 1);
  try {
    let value: unknown;
    if (message.operation.kind === "implementation") {
      store.deliveryExecutions.completeImplementation(message.operation.claim, message.operation.completion);
    } else if (message.operation.kind === "quality") {
      store.deliveryQuality.complete(message.operation.claim, message.operation.completion);
    } else if (message.operation.kind === "pause") {
      value = store.deliveryCoordination.pauseAutomation(message.operation.input);
    } else {
      value = store.automationJobs.leaseNext(message.operation.workerId, new Date(message.operation.now),
        message.operation.leaseMs);
    }
    parentPort!.postMessage({ type: "result", iteration: message.iteration, threadId, ok: true, value });
  } catch (error) {
    parentPort!.postMessage({ type: "result", iteration: message.iteration, threadId, ok: false,
      error: error instanceof Error ? error.message : String(error) });
  } finally {
    store.close();
  }
});
