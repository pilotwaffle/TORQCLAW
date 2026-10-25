// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { GatewayEvent } from '@torqclaw/contracts';

if (typeof Element !== 'undefined' && !Element.prototype.scrollTo) {
  Element.prototype.scrollTo = function scrollTo() {};
}

const stream = {
  events: [] as GatewayEvent[], isConnected: true,
  sendCommand: vi.fn(() => true), reconnect: vi.fn(),
};
vi.mock('../apps/console/src/components/useGatewayStream.js', () => ({ useGatewayStream: () => stream }));

import TorqTerminal from '../apps/console/src/components/TorqTerminal.js';
import { derivePreflightEstimate } from '../apps/console/src/components/friendly.js';

afterEach(() => {
  cleanup();
  stream.events = [];
  stream.sendCommand.mockClear();
  vi.useRealTimers();
});

function previewFrame(nonce: string, meta: Record<string, unknown>): GatewayEvent {
  return {
    id: 'preview-1', requestId: null, sessionId: 's', tier: null,
    type: 'SYSTEM', message: 'Route preview', timestamp: '2026-01-01T00:00:00.000Z',
    metadata: { routePreview: true, previewOf: nonce, diagnostics: { tier: 'OLLAMA_LOCAL' }, ...meta },
  } as GatewayEvent;
}

function renderEstimate(meta: Record<string, unknown>) {
  vi.useFakeTimers();
  const { rerender } = render(<TorqTerminal />);
  fireEvent.change(screen.getByLabelText('Describe your task'), { target: { value: 'summarize this file' } });
  act(() => { vi.advanceTimersByTime(500); });
  const previews = stream.sendCommand.mock.calls.map(([command]: any[]) => command)
    .filter((command: any) => command.action === 'PREVIEW_ROUTE');
  expect(previews).toHaveLength(1);
  stream.events = [previewFrame(previews[0].previewOf, meta)];
  rerender(<TorqTerminal />);
  return screen.getByText('$0.00 · local').closest('span[class*="animate-task-enter"]');
}

it('estimate_chip_tooltip_names_classifier_fallback_reason', () => {
  const chip = renderEstimate({
    enrichment: { classifierUsed: 'DEFAULT', classifierLatencyMs: 1510 },
    classifierFallbackReason: 'timeout',
  });
  expect(chip).toHaveAttribute('title', 'classifier fell back (timeout, 1510 ms)');
});

it('estimate_chip_has_no_tooltip_for_local_llm_classification', () => {
  const chip = renderEstimate({ enrichment: { classifierUsed: 'LOCAL_LLM', classifierLatencyMs: 20 } });
  expect(chip).not.toHaveAttribute('title');
});

it('derive_preflight_estimate_classifier_note', () => {
  const estimate = (meta: Record<string, unknown>) => derivePreflightEstimate(previewFrame('n1', meta));
  expect(estimate({ enrichment: { classifierUsed: 'DEFAULT', classifierLatencyMs: 2.4 } })?.classifierNote)
    .toBe('classifier fell back (reason unknown, 2 ms)');
  expect(estimate({ enrichment: { classifierUsed: 'KEYWORD_FALLBACK', classifierLatencyMs: 2 } })?.classifierNote)
    .toBe('classifier fell back (reason unknown, 2 ms)');
  expect(estimate({
    diagnostics: { tier: 'API_EXTERNAL' }, enrichment: { classifierUsed: 'KEYWORD_FALLBACK', estimatedTokens: 100 },
    classifierFallbackReason: 'unreachable',
  })?.classifierNote).toBe('classifier fell back (unreachable)');
  expect(estimate({ enrichment: { classifierUsed: 'DEFAULT', classifierLatencyMs: Number.NaN } })?.classifierNote)
    .toBe('classifier fell back (reason unknown)');
  for (const meta of [
    { enrichment: { classifierUsed: 'LOCAL_LLM' }, classifierFallbackReason: 'timeout' },
    {},
  ]) {
    const est = estimate(meta);
    expect(est).not.toHaveProperty('classifierNote');
    expect(est).toEqual({ route: 'local', label: '$0.00 · local', estimatedTokens: null });
  }
});
