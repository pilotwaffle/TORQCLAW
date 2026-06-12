import { ComputeTier, type GatewayRequest, type RouterDiagnostics } from '@torqclaw/contracts';
import { executeLocalEdge } from '@torqclaw/inference';
import { executeHermesTask } from '@torqclaw/bridge';
import { makeEmitter, taskStore } from './events.js';
import { sessions } from './sessions.js';

const sanitize = (msg: string) => msg.replace(/Bearer\s+\S+/gi, 'Bearer ***').slice(0, 2_000);

/** Fire-and-forget: the WS handler returns immediately; execution reports to
 *  the session bus, so sockets can drop and reconnect mid-task freely. */
export function dispatch(req: GatewayRequest, diag: RouterDiagnostics): void {
  const emit = makeEmitter(req.sessionId, req.id, diag.tier);
  taskStore.create(req, diag); // persist BEFORE executing

  void (async () => {
    try {
      const result =
        diag.tier === ComputeTier.LOCAL_EDGE
          ? await executeLocalEdge(req, emit)
          : await executeHermesTask(req, emit);

      taskStore.complete(req.id, result.text);
      sessions.storeEpisode(
        req.id, req.sessionId, req.payload.taskType, req.payload.prompt, result.text,
      );
      emit('RESULT', result.text, result.telemetry);
    } catch (error: any) {
      taskStore.fail(req.id, String(error?.message ?? error));
      emit('ERROR', `Execution failed: ${sanitize(String(error?.message ?? error))}`);
    }
  })();
}
