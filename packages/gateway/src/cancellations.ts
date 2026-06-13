/** In-memory cancellation flags for LOCAL_EDGE tasks. FRONTIER cancellation
 *  goes through the engine's cancel_task MCP tool (the agent runs in Python);
 *  LOCAL_EDGE runs in this process, so the ollama loop polls this flag between
 *  iterations and between tool calls. Single-process gateway — a Map is enough.
 *  Flags are set on CANCEL_TASK and cleared once the loop observes them. */
const cancelled = new Set<string>();

export const cancellations = {
  request(requestId: string): void {
    cancelled.add(requestId);
  },
  isCancelled(requestId: string): boolean {
    return cancelled.has(requestId);
  },
  clear(requestId: string): void {
    cancelled.delete(requestId);
  },
};
