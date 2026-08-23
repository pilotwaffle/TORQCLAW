import { afterEach, describe, expect, it } from 'vitest';
import { subscriptionAgentExecutionEnabled } from '../packages/gateway/src/subscriptionExecutionAdmission.js';

const ORIGINAL = process.env.TORQCLAW_SUBSCRIPTION_AGENT_EXECUTION_ENABLED;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.TORQCLAW_SUBSCRIPTION_AGENT_EXECUTION_ENABLED;
  else process.env.TORQCLAW_SUBSCRIPTION_AGENT_EXECUTION_ENABLED = ORIGINAL;
});

describe('subscription execution feature gate', () => {
  it.each([undefined, '', '   '])('is default-on for unset/empty value %s', (value) => {
    if (value === undefined) delete process.env.TORQCLAW_SUBSCRIPTION_AGENT_EXECUTION_ENABLED;
    else process.env.TORQCLAW_SUBSCRIPTION_AGENT_EXECUTION_ENABLED = value;
    expect(subscriptionAgentExecutionEnabled()).toBe(true);
  });

  it.each(['1', 'true', 'TRUE', 'yes', 'on'])('accepts true alias %s', (value) => {
    process.env.TORQCLAW_SUBSCRIPTION_AGENT_EXECUTION_ENABLED = value;
    expect(subscriptionAgentExecutionEnabled()).toBe(true);
  });

  it.each(['0', 'false', 'FALSE', 'no', 'off', 'enabled', 'maybe'])('disables false or malformed value %s', (value) => {
    process.env.TORQCLAW_SUBSCRIPTION_AGENT_EXECUTION_ENABLED = value;
    expect(subscriptionAgentExecutionEnabled()).toBe(false);
  });

  it('does not retain a prior explicit value after deletion', () => {
    process.env.TORQCLAW_SUBSCRIPTION_AGENT_EXECUTION_ENABLED = 'off';
    expect(subscriptionAgentExecutionEnabled()).toBe(false);
    delete process.env.TORQCLAW_SUBSCRIPTION_AGENT_EXECUTION_ENABLED;
    expect(subscriptionAgentExecutionEnabled()).toBe(true);
  });
});
