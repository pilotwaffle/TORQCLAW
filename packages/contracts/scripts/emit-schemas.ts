/**
 * Emits JSON Schema artifacts from the Zod source of truth.
 * Dual-emit: packages/contracts/generated/ (TS consumers/docs) AND
 * engines/hermes_kernel/mcp_wrapper/schemas/ (so the Python engine is
 * self-contained when deployed to a separate GPU box).
 */
import { z } from 'zod';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// Import from dist (tsc runs first in the build script): the NodeNext-style
// `.js` extension imports inside src/ don't resolve under --experimental-strip-types.
import {
  GatewayRequestSchema,
  GatewayEventSchema,
  ClientCommandSchema,
  ConnectFrameSchema,
  ResilienceImmutablePlanSchema,
  ResilienceActiveTupleSchema,
  ResilienceNormalizedFailureSchema,
  ResilienceOutboxEventSchema,
  augmentResilienceImmutablePlanJsonSchema,
} from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const targets = [
  join(here, '..', 'generated'),
  join(here, '..', '..', '..', 'engines', 'hermes_kernel', 'mcp_wrapper', 'schemas'),
];

const artifacts: Record<string, z.ZodType> = {
  GatewayRequest: GatewayRequestSchema,
  GatewayEvent: GatewayEventSchema,
  ClientCommand: ClientCommandSchema,
  ConnectFrame: ConnectFrameSchema,
  ResilienceImmutablePlan: ResilienceImmutablePlanSchema,
  ResilienceActiveTuple: ResilienceActiveTupleSchema,
  ResilienceNormalizedFailure: ResilienceNormalizedFailureSchema,
  ResilienceOutboxEvent: ResilienceOutboxEventSchema,
};

for (const dir of targets) {
  mkdirSync(dir, { recursive: true });
  for (const [name, schema] of Object.entries(artifacts)) {
    const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
    const emitted = name === 'ResilienceImmutablePlan'
      ? augmentResilienceImmutablePlanJsonSchema(jsonSchema)
      : jsonSchema;
    writeFileSync(join(dir, `${name}.json`), JSON.stringify(emitted, null, 2));
  }
  console.log(`[contracts] emitted ${Object.keys(artifacts).length} schemas -> ${dir}`);
}
