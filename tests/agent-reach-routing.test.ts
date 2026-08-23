import { describe, expect, it } from 'vitest';
import { TorqClawRouter } from '../packages/router/src/engine.js';
import { detectAgentReachChannels, parseAgentReachDoctor } from '../packages/bridge/src/agentReachProbe.js';
import { ComputeTier } from '@torqclaw/contracts';
import { makeRequest } from './helpers.js';

describe('Agent Reach routing', () => {
  it('detects explicit platforms without hijacking generic search', () => {
    expect(detectAgentReachChannels('summarize this YouTube video')).toEqual(['youtube']);
    expect(detectAgentReachChannels('search the web for torqclaw')).toEqual([]);
  });

  it('trusts only ok channels with an active backend', () => {
    const snapshot = parseAgentReachDoctor({
      youtube: { status: 'ok', active_backend: 'yt-dlp' },
      reddit: { status: 'warn', active_backend: null },
    });
    expect([...snapshot.available]).toEqual(['youtube']);
  });

  it('prefers confirmed local availability', () => {
    const request = makeRequest();
    request.enrichment.agentReach = {
      requestedChannels: ['youtube'], localChannels: ['youtube'], frontierChannels: [],
      localSatisfies: true, frontierSatisfies: false, writeIntent: false,
    };
    const decision = new TorqClawRouter().evaluateRequest(request);
    expect(decision.tier).toBe(ComputeTier.LOCAL_EDGE);
    expect(decision.ruleId).toBe('AGENT_REACH_LOCAL');
  });

  it('uses frontier only when missing locally and confirmed there', () => {
    const request = makeRequest();
    request.enrichment.agentReach = {
      requestedChannels: ['reddit'], localChannels: [], frontierChannels: ['reddit'],
      localSatisfies: false, frontierSatisfies: true, writeIntent: true,
    };
    const decision = new TorqClawRouter().evaluateRequest(request);
    expect(decision.tier).toBe(ComputeTier.FRONTIER);
    expect(decision.ruleId).toBe('AGENT_REACH_FRONTIER');
  });
});
