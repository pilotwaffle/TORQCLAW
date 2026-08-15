// @vitest-environment jsdom
// Composer attachments (redesign 7/7), feature-flagged. KERNEL GAP pinned by
// this suite: the gateway exposes NO upload command (attachmentIds exists on
// SUBMIT_PROMPT but nothing populates it), so with the flag ON the composer
// collects files, warns on the cloud route, and GATES submission — it never
// sends fake ids and never silently drops attached files. Flag OFF (default):
// no paperclip, zero behavior change. TorqTerminal reads the flag at module
// evaluation, so each scenario resets modules and stubs the env before a
// dynamic import.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { GatewayEvent } from '@torqclaw/contracts';

if (typeof Element !== 'undefined' && !Element.prototype.scrollTo) {
  Element.prototype.scrollTo = function scrollTo() {};
}

const stream: {
  events: GatewayEvent[];
  isConnected: boolean;
  sendCommand: ReturnType<typeof vi.fn>;
  reconnect: ReturnType<typeof vi.fn>;
} = {
  events: [],
  isConnected: true,
  sendCommand: vi.fn(() => true),
  reconnect: vi.fn(),
};
vi.mock('../apps/console/src/components/useGatewayStream.js', () => ({
  useGatewayStream: () => stream,
}));

const INPUT_LABEL = 'Describe your task';

afterEach(() => {
  cleanup();
  stream.events = [];
  stream.sendCommand.mockClear();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function loadTerminal(flag: string) {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_ATTACHMENTS', flag);
  const mod = await import('../apps/console/src/components/TorqTerminal.js');
  return mod.default;
}

let idCounter = 0;
function ev(p: Partial<GatewayEvent>): GatewayEvent {
  idCounter++;
  return {
    id: `id-${idCounter}`,
    requestId: null,
    sessionId: 's',
    tier: null,
    type: 'SYSTEM',
    message: '',
    timestamp: '2026-01-01T00:00:00.000Z',
    ...p,
  } as GatewayEvent;
}

describe('TorqTerminal — attachments flag OFF (default)', () => {
  it('renders no paperclip and no attachment surface', async () => {
    const TorqTerminal = await loadTerminal('');
    render(<TorqTerminal />);
    expect(screen.queryByLabelText('attach files')).not.toBeInTheDocument();
  });
});

describe('TorqTerminal — attachments flag ON', () => {
  it('paperclip attaches a PDF chip (red tile) with per-file remove', async () => {
    const TorqTerminal = await loadTerminal('1');
    render(<TorqTerminal />);

    const picker = screen.getByLabelText('attach files');
    const pdf = new File(['%PDF-1.4 fake'], 'report.pdf', { type: 'application/pdf' });
    fireEvent.change(picker, { target: { files: [pdf] } });

    const chip = screen.getByText('report.pdf').closest('span[class*="border"]')!;
    expect(chip.className).toContain('text-bad'); // pdf = red tile

    fireEvent.click(screen.getByLabelText('remove report.pdf'));
    expect(screen.queryByText('report.pdf')).not.toBeInTheDocument();
  });

  it('doc files render the amber tile', async () => {
    const TorqTerminal = await loadTerminal('1');
    render(<TorqTerminal />);

    const doc = new File(['x'], 'notes.docx', { type: 'application/octet-stream' });
    fireEvent.change(screen.getByLabelText('attach files'), { target: { files: [doc] } });
    const chip = screen.getByText('notes.docx').closest('span[class*="border"]')!;
    expect(chip.className).toContain('text-torque');
  });

  it('submit GATES while files are attached — never fake ids, never silent drop', async () => {
    const TorqTerminal = await loadTerminal('1');
    render(<TorqTerminal />);

    fireEvent.change(screen.getByLabelText('attach files'), {
      target: { files: [new File(['x'], 'report.pdf', { type: 'application/pdf' })] },
    });
    fireEvent.change(screen.getByLabelText(INPUT_LABEL), { target: { value: 'summarize this' } });
    fireEvent.submit(screen.getByLabelText(INPUT_LABEL).closest('form')!);

    // Nothing dispatched — the kernel has no upload pipeline to carry the file.
    expect(stream.sendCommand).not.toHaveBeenCalled();
    expect(screen.getByText(/kernel exposes no upload/)).toBeInTheDocument();

    // Remove the file and submission works again.
    fireEvent.click(screen.getByLabelText('remove report.pdf'));
    fireEvent.submit(screen.getByLabelText(INPUT_LABEL).closest('form')!);
    expect(stream.sendCommand).toHaveBeenCalledTimes(1);
    const cmd = stream.sendCommand.mock.calls[0][0] as any;
    expect(cmd.action).toBe('SUBMIT_PROMPT');
    expect(cmd.attachmentIds).toEqual([]); // honest: never a fabricated id
  });

  it('warns on the cloud route: "N attachments will be uploaded" — disappears on local', async () => {
    vi.useFakeTimers();
    const TorqTerminal = await loadTerminal('1');
    const { rerender } = render(<TorqTerminal />);

    fireEvent.change(screen.getByLabelText('attach files'), {
      target: { files: [new File(['x'], 'a.pdf', { type: 'application/pdf' })] },
    });

    // Size the draft: kernel pass says cloud.
    fireEvent.change(screen.getByLabelText(INPUT_LABEL), { target: { value: 'deep research' } });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    const previewCall = stream.sendCommand.mock.calls.map(([c]) => c).find((c: any) => c.action === 'PREVIEW_ROUTE') as any;
    expect(previewCall).toBeDefined();
    stream.events = [ev({
      type: 'SYSTEM', message: 'Route preview',
      metadata: { routePreview: true, previewOf: previewCall.previewOf, diagnostics: { tier: 'API_EXTERNAL' }, enrichment: { estimatedTokens: 900 } },
    })];
    rerender(<TorqTerminal />);
    expect(screen.getByText(/1 attachment will be uploaded with this task — route is cloud/)).toBeInTheDocument();

    // Local route -> the warning disappears. A new settled draft re-dispatches
    // PREVIEW_ROUTE; answer it with the local tier.
    fireEvent.change(screen.getByLabelText(INPUT_LABEL), { target: { value: 'deep research now' } });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    const localCall = stream.sendCommand.mock.calls.map(([c]) => c).filter((c: any) => c.action === 'PREVIEW_ROUTE').at(-1) as any;
    stream.events = [ev({
      type: 'SYSTEM', message: 'Route preview',
      metadata: { routePreview: true, previewOf: localCall.previewOf, diagnostics: { tier: 'OLLAMA_LOCAL' } },
    })];
    rerender(<TorqTerminal />);
    expect(screen.queryByText(/will be uploaded/)).not.toBeInTheDocument();
  });
});
