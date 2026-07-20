import { parentPort, threadId } from "node:worker_threads";
import { WorkflowStore } from "./store.js";
import type { DeliveryQualityClaim, DeliveryQualityCompletion } from "./delivery-quality-repository.js";

if (!parentPort) throw new Error("DELIVERY_COORDINATOR_RACE_PARENT_REQUIRED");

interface RaceMessage {
  type: "prepare";
  iteration: number;
  databasePath: string;
  claim: DeliveryQualityClaim;
  completion: DeliveryQualityCompletion;
  barrier: SharedArrayBuffer;
}

parentPort.on("message", (message: RaceMessage) => {
  if (message.type !== "prepare") return;
  let store: WorkflowStore | undefined;
  try {
    store = new WorkflowStore(message.databasePath);
    const barrier = new Int32Array(message.barrier);
    Atomics.add(barrier, 0, 1);
    Atomics.notify(barrier, 0);
    parentPort!.postMessage({ type: "ready", iteration: message.iteration, threadId });
    while (Atomics.load(barrier, 1) === 0) Atomics.wait(barrier, 1, 0);
    let startedAt: bigint | undefined;
    const beginImmediate = store.withImmediateTransaction.bind(store);
    (store as any).withImmediateTransaction = (operation: () => unknown) => {
      startedAt = process.hrtime.bigint();
      const callers = Atomics.add(barrier, 2, 1) + 1;
      Atomics.notify(barrier, 2);
      if (callers < 2) {
        while (Atomics.load(barrier, 2) < 2) Atomics.wait(barrier, 2, 1);
      }
      return beginImmediate(operation);
    };
    const evidence = store.deliveryQuality.complete(message.claim, message.completion);
    const finishedAt = process.hrtime.bigint();
    parentPort!.postMessage({
      type: "result", iteration: message.iteration, threadId,
      startedAt: startedAt!.toString(), finishedAt: finishedAt.toString(), evidenceId: evidence.id
    });
  } catch (error) {
    parentPort!.postMessage({
      type: "error", iteration: message.iteration, threadId,
      error: error instanceof Error ? error.message : String(error)
    });
  } finally {
    store?.close();
  }
});
