import { describe, expect, it } from 'vitest';
import {
  localExecutionTargetForProfile,
  runtimeProfileAllowsAutomaticTurn,
} from '../packages/gateway/src/autoReplyDispatcher.js';

const localProfile = {
  providerAccountId: 'ollama-local',
  adapterId: 'untrusted-browser-value',
  modelId: 'torq-ai-v5',
  autostart: true,
  externalContextConfirmed: false,
};

describe('per-agent local model routing', () => {
  it('requires autostart for profiled local agents while preserving legacy fallback', () => {
    expect(runtimeProfileAllowsAutomaticTurn(null)).toBe(false);
    expect(runtimeProfileAllowsAutomaticTurn({ ...localProfile, autostart: false })).toBe(false);
    expect(runtimeProfileAllowsAutomaticTurn(localProfile)).toBe(true);
  });

  it('mints a gateway-owned target and never trusts the stored adapter', () => {
    expect(localExecutionTargetForProfile(localProfile)).toEqual({
      providerId: 'ollama-local',
      adapterId: 'ollama-local',
      modelId: 'torq-ai-v5',
    });
    expect(localExecutionTargetForProfile(null)).toBeUndefined();
    expect(localExecutionTargetForProfile({
      ...localProfile,
      providerAccountId: 'claude-subscription',
    })).toBeUndefined();
  });
});
