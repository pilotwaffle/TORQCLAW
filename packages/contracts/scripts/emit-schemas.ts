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
import { GatewayRequestSchema, GatewayEventSchema, ClientCommandSchema } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const targets = [
  join(here, '..', 'generated'),
  join(here, '..', '..', '..', 'engines', 'hermes_kernel', 'mcp_wrapper', 'schemas'),
];

const artifacts: Record<string, z.ZodType> = {
  GatewayRequest: GatewayRequestSchema,
  GatewayEvent: GatewayEventSchema,
  ClientCommand: ClientCommandSchema,
};

for (const dir of targets) {
  mkdirSync(dir, { recursive: true });
  for (const [name, schema] of Object.entries(artifacts)) {
    writeFileSync(join(dir, `${name}.json`), JSON.stringify(z.toJSONSchema(schema), null, 2));
  }
  console.log(`[contracts] emitted ${Object.keys(artifacts).length} schemas -> ${dir}`);
}
