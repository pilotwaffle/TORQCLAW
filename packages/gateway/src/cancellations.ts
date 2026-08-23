/** In-memory cancellation flags for LOCAL_EDGE tasks. FRONTIER cancellation
 *  goes through the engine's cancel_task MCP tool (the agent runs in Python);
 *  LOCAL_EDGE runs in this process, so the ollama loop polls this flag between
 *  iterations and between tool calls. Single-process gateway — a Map is enough.
 *  Flags are set on CANCEL_TASK and cleared once the loop observes them. */
const cancelled = new Set<string>();
const controllers = new Map<string, AbortController>();
type TerminationTracker = {
  promise: Promise<boolean>;
  resolve: (confirmed: boolean) => void;
  settled: boolean;
};
const terminationTrackers = new Map<string, TerminationTracker>();

function controllerFor(requestId: string): AbortController {
  let controller = controllers.get(requestId);
  if (!controller) {
    controller = new AbortController();
    controllers.set(requestId, controller);
  }
  if (cancelled.has(requestId)) controller.abort();
  return controller;
}

export const cancellations = {
  request(requestId: string): void {
    cancelled.add(requestId);
    controllers.get(requestId)?.abort();
  },
  async requestAndWait(requestId: string): Promise<{ tracked: boolean; confirmed: boolean }> {
    cancelled.add(requestId);
    controllers.get(requestId)?.abort();
    const tracker = terminationTrackers.get(requestId);
    if (!tracker) return { tracked: false, confirmed: true };
    return { tracked: true, confirmed: await tracker.promise };
  },
  isCancelled(requestId: string): boolean {
    return cancelled.has(requestId);
  },
  signal(requestId: string): AbortSignal {
    return controllerFor(requestId).signal;
  },
  beginTerminationTracking(requestId: string): {
    signal: AbortSignal;
    complete: (confirmed: boolean) => void;
  } {
    let resolvePromise!: (confirmed: boolean) => void;
    const tracker: TerminationTracker = {
      promise: new Promise<boolean>((resolve) => { resolvePromise = resolve; }),
      resolve: resolvePromise,
      settled: false,
    };
    terminationTrackers.set(requestId, tracker);
    return {
      signal: controllerFor(requestId).signal,
      complete(confirmed: boolean): void {
        if (tracker.settled) return;
        tracker.settled = true;
        tracker.resolve(confirmed);
      },
    };
  },
  clear(requestId: string): void {
    cancelled.delete(requestId);
    controllers.delete(requestId);
    terminationTrackers.delete(requestId);
  },
};
