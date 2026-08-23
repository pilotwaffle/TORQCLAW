// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientCommand, GatewayEvent } from '@torqclaw/contracts';
import { ClientCommandSchema } from '@torqclaw/contracts';
import AgentsPanel from '../apps/console/src/components/AgentsPanel';

const IDEMPOTENCY_KEY = '123e4567-e89b-42d3-a456-426614174000';

function event(metadata: Record<string, unknown>, id: string): GatewayEvent {
  return {
    id,
    requestId: `request-${id}`,
    sessionId: 'session-agents-test',
    type: 'SYSTEM',
    tier: 'OLLAMA_LOCAL',
    message: 'test frame',
    timestamp: '2026-08-20T12:00:00.000Z',
    metadata,
  } as GatewayEvent;
}

function fixtures(): GatewayEvent[] {
  return [
    event({
      collabAgents: true,
      agents: [{
        principalId: 'agent-1',
        displayName: 'Research Scout',
        status: 'active',
        providerId: 'ollama-local',
        modelId: 'qwen-local:latest',
        iconId: 'search',
        systemDirectives: 'Research first. Cite evidence.',
        personaRevision: 3,
        channels: [{ channelId: 'channel-research', channelName: 'research' }],
      }, {
        principalId: 'agent-external',
        displayName: 'External Scout',
        status: 'active',
        providerId: 'qwen-subscription',
        modelId: 'qwen3.8-max-preview',
        externalContextConfirmed: false,
        iconId: 'robot',
        systemDirectives: 'Use primary evidence.',
        personaRevision: 2,
        channels: [],
      }],
    }, 'agents'),
    event({
      agentProviders: true,
      providers: [
        {
          id: 'ollama-local',
          label: 'Local Ollama',
          status: 'available',
          executionReady: true,
          authKind: 'none',
          models: [{ id: 'qwen-local:latest', label: 'Qwen Local', executionReady: true, note: 'Local execution is ready.' }],
          note: 'Runs through the configured local Ollama endpoint.',
        },
        {
          id: 'claude-subscription',
          label: 'Claude subscription',
          status: 'connected',
          executionReady: false,
          authKind: 'external_cli_session',
          models: [
            { id: 'claude-opus', label: 'Claude Opus', executionReady: false, note: 'Disabled until canonical dispatch.' },
            { id: 'claude-sonnet', label: 'Claude Sonnet', executionReady: false, note: 'Disabled until canonical dispatch.' },
          ],
          note: 'Detected, but the subscription execution adapter is not enabled.',
        },
      ],
    }, 'providers'),
    event({
      collabChannels: true,
      channels: [
        { channelId: 'channel-research', name: 'research' },
        { channelId: 'channel-build', name: 'build-room' },
      ],
    }, 'channels'),
  ];
}

function renderPanel(
  events: GatewayEvent[] = fixtures(),
  sendCommand = vi.fn<(command: ClientCommand) => boolean>(() => true),
) {
  const result = render(<AgentsPanel events={events} sendCommand={sendCommand} onClose={vi.fn()} />);
  return { ...result, sendCommand };
}

beforeEach(() => {
  vi.stubGlobal('crypto', { randomUUID: vi.fn(() => IDEMPOTENCY_KEY) });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AgentsPanel', () => {
  it('dispatches only the three roster bootstrap reads on mount', () => {
    const { sendCommand } = renderPanel();

    expect(sendCommand.mock.calls.map(([command]) => command)).toEqual([
      { action: 'LIST_AGENTS', limit: 50 },
      { action: 'LIST_AGENT_PROVIDERS' },
      { action: 'LIST_CHANNELS', limit: 100 },
    ]);
  });

  it('renders the agent roster and the provider/model catalog strictly from frames', async () => {
    renderPanel();

    expect(screen.getByRole('heading', { name: 'Research Scout' })).toBeInTheDocument();
    expect(screen.getByText('qwen-local:latest')).toBeInTheDocument();
    expect(screen.getByText('#research')).toBeInTheDocument();
    expect(screen.getAllByText('active')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'New agent' }));
    const providerSelect = screen.getByLabelText('Provider account');
    expect(within(providerSelect).getByRole('option', { name: 'Local Ollama - available' })).toBeInTheDocument();
    expect(within(providerSelect).getByRole('option', { name: 'Claude subscription - connected' })).toBeInTheDocument();

    fireEvent.change(providerSelect, { target: { value: 'claude-subscription' } });
    await waitFor(() => expect(screen.getByLabelText('Model')).toHaveValue('claude-opus'));
    const modelSelect = screen.getByLabelText('Model');
    expect(within(modelSelect).getByRole('option', { name: 'Claude Opus - disabled' })).toBeInTheDocument();
    expect(within(modelSelect).getByRole('option', { name: 'Claude Sonnet - disabled' })).toBeInTheDocument();

    expect(screen.queryByText(/\bonline\b/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/\boffline\b/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/\baway\b/i)).not.toBeInTheDocument();
  });

  it('keeps subscription creation disabled and exposes no secret-bearing input', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'New agent' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Claude Worker' } });
    fireEvent.change(screen.getByLabelText('Provider account'), { target: { value: 'claude-subscription' } });

    expect(screen.getByRole('button', { name: 'Add agent' })).toBeDisabled();
    expect(screen.getByText(/subscription execution adapter is not enabled/i)).toBeInTheDocument();
    expect(screen.getByText(/External agents are created inactive/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Enable automatic replies/i)).toBeDisabled();
    expect(screen.queryByLabelText(/Confirm external context and runtime trust/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /api key|secret|token|password/i })).not.toBeInTheDocument();
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });

  it('sends a schema-valid local CREATE_AGENT with selected channels and a UUID', async () => {
    const { sendCommand } = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'New agent' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  Build Worker  ' } });
    fireEvent.click(screen.getByLabelText('#research'));
    fireEvent.click(screen.getByLabelText('#build-room'));

    await waitFor(() => expect(screen.getByLabelText('Model')).toHaveValue('qwen-local:latest'));
    fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));

    const createCalls = sendCommand.mock.calls
      .map(([command]) => command)
      .filter((command) => command.action === 'CREATE_AGENT');
    expect(createCalls).toEqual([{
      action: 'CREATE_AGENT',
      displayName: 'Build Worker',
      providerId: 'ollama-local',
      modelId: 'qwen-local:latest',
      autostart: false,
      externalContextConfirmed: false,
      channelIds: ['channel-research', 'channel-build'],
      idempotencyKey: IDEMPOTENCY_KEY,
    }]);
    expect(ClientCommandSchema.safeParse(createCalls[0]).success).toBe(true);
  });

  it('opens an agent card and sends a schema-valid icon/directives update', () => {
    const { sendCommand } = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Research Scout' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText('Instructions')).toHaveValue('Research first. Cite evidence.');
    expect(screen.getByLabelText('Search')).toBeChecked();

    fireEvent.click(screen.getByLabelText('Shield'));
    fireEvent.change(screen.getByLabelText('Instructions'), {
      target: { value: 'Protect sensitive data. Be concise.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save agent profile' }));

    const command = sendCommand.mock.calls.map(([value]) => value)
      .find((value) => value.action === 'UPDATE_AGENT_PROFILE');
    expect(command).toEqual({
      action: 'UPDATE_AGENT_PROFILE',
      agentPrincipalId: 'agent-1',
      iconId: 'shield',
      systemDirectives: 'Protect sensitive data. Be concise.',
      expectedRevision: 3,
      reconfirmExternalContext: false,
      idempotencyKey: IDEMPOTENCY_KEY,
    });
  });

  it('requires an explicit editor reconsent for an external agent', () => {
    const { sendCommand } = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Edit External Scout' }));
    const consent = screen.getByLabelText(/Reconfirm external context and enable replies/i);
    expect(consent).not.toBeChecked();
    fireEvent.click(consent);
    fireEvent.click(screen.getByRole('button', { name: 'Save agent profile' }));
    expect(sendCommand.mock.calls.map(([value]) => value).find((value) => value.action === 'UPDATE_AGENT_PROFILE'))
      .toMatchObject({ reconfirmExternalContext: true, expectedRevision: 2 });
  });

  it('surfaces a dropped CREATE_AGENT when the gateway send fails', async () => {
    const sendCommand = vi.fn<(command: ClientCommand) => boolean>(
      (command) => command.action !== 'CREATE_AGENT',
    );
    renderPanel(fixtures(), sendCommand);
    fireEvent.click(screen.getByRole('button', { name: 'New agent' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Local Worker' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add agent' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));

    expect(screen.getByText('The gateway connection is not open.')).toBeInTheDocument();
    expect(sendCommand.mock.calls.some(([command]) => command.action === 'CREATE_AGENT')).toBe(true);
  });
});

describe('agent wire command contracts', () => {
  it('applies list defaults and accepts the bounded agent create shape', () => {
    expect(ClientCommandSchema.parse({ action: 'LIST_AGENTS' })).toEqual({ action: 'LIST_AGENTS', limit: 50 });
    expect(ClientCommandSchema.parse({ action: 'LIST_AGENT_PROVIDERS' })).toEqual({ action: 'LIST_AGENT_PROVIDERS' });
    expect(ClientCommandSchema.parse({
      action: 'CREATE_AGENT',
      displayName: 'Worker',
      providerId: 'ollama-local',
      modelId: 'qwen-local:latest',
      idempotencyKey: IDEMPOTENCY_KEY,
    })).toEqual({
      action: 'CREATE_AGENT',
      displayName: 'Worker',
      providerId: 'ollama-local',
      modelId: 'qwen-local:latest',
      autostart: false,
      channelIds: [],
      externalContextConfirmed: false,
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    expect(ClientCommandSchema.safeParse({
      action: 'UPDATE_AGENT_PROFILE',
      agentPrincipalId: IDEMPOTENCY_KEY,
      iconId: 'robot',
      systemDirectives: 'Be concise.',
      expectedRevision: 0,
      idempotencyKey: IDEMPOTENCY_KEY,
    }).success).toBe(true);
    expect(ClientCommandSchema.safeParse({
      action: 'UPDATE_AGENT_PROFILE',
      agentPrincipalId: IDEMPOTENCY_KEY,
      iconId: 'remote-url',
      systemDirectives: '',
      expectedRevision: 0,
      idempotencyKey: IDEMPOTENCY_KEY,
    }).success).toBe(false);
  });

  it('keeps the editor open when a profile revision conflict is reported', () => {
    const rendered = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Research Scout' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save agent profile' }));
    rendered.rerender(<AgentsPanel
      events={[...fixtures(), event({
        agentMutationTerminal: true,
        operation: 'update',
        idempotencyKey: IDEMPOTENCY_KEY,
        status: 'conflict',
        conflict: 'revision',
        message: 'Agent profile changed; reload it before saving.',
      }, 'profile-conflict'), event({
        agentMutationTerminal: true,
        operation: 'update',
        idempotencyKey: '123e4567-e89b-42d3-a456-426614174099',
        status: 'success',
        message: 'Agent profile updated.',
      }, 'unrelated-newer')]}
      sendCommand={rendered.sendCommand}
      onClose={vi.fn()}
    />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/profile changed; reload it/i)).toBeInTheDocument();
  });

  it('closes only on matching success and restores focus to the opener', async () => {
    const rendered = renderPanel();
    const opener = screen.getByRole('button', { name: 'New agent' });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Worker' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add agent' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));
    rendered.rerender(<AgentsPanel
      events={[...fixtures(), event({
        agentMutationTerminal: true,
        operation: 'create',
        idempotencyKey: IDEMPOTENCY_KEY,
        status: 'success',
        message: 'Agent created.',
      }, 'create-success')]}
      sendCommand={rendered.sendCommand}
      onClose={vi.fn()}
    />);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });

  it('rejects unsafe directives and invalid revisions at the wire boundary', () => {
    const base = {
      action: 'UPDATE_AGENT_PROFILE',
      agentPrincipalId: IDEMPOTENCY_KEY,
      iconId: 'robot',
      idempotencyKey: IDEMPOTENCY_KEY,
    } as const;
    expect(ClientCommandSchema.safeParse({ ...base, systemDirectives: 'line one\nline two\t', expectedRevision: 0 }).success).toBe(true);
    expect(ClientCommandSchema.safeParse({ ...base, systemDirectives: 'unsafe\u202Etext', expectedRevision: 0 }).success).toBe(false);
    expect(ClientCommandSchema.safeParse({ ...base, systemDirectives: 'unsafe\u0007text', expectedRevision: 0 }).success).toBe(false);
    expect(ClientCommandSchema.safeParse({ ...base, systemDirectives: 'safe', expectedRevision: -1 }).success).toBe(false);
  });

  it('keeps the drawer open and reports compensated channel provisioning failures', async () => {
    const rendered = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'New agent' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Worker' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add agent' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));
    rendered.rerender(<AgentsPanel
      events={[...fixtures(), event({
        agentMutationTerminal: true,
        operation: 'create',
        idempotencyKey: IDEMPOTENCY_KEY,
        status: 'error',
        errorCode: 'provisioning_failed',
        message: 'Agent provisioning failed; no changes were committed.',
        membershipResults: [{ channelId: 'channel-build', ok: false, error: 'Channel assignment failed' }],
      }, 'failed-mutation')]}
      sendCommand={rendered.sendCommand}
      onClose={vi.fn()}
    />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/no changes were committed.*channel-build/i)).toBeInTheDocument();
  });

  it('rejects malformed UUIDs, blank identities, and oversized channel assignments', () => {
    const base = {
      action: 'CREATE_AGENT',
      displayName: 'Worker',
      providerId: 'ollama-local',
      modelId: 'qwen-local:latest',
      channelIds: [],
      idempotencyKey: IDEMPOTENCY_KEY,
    } as const;

    expect(ClientCommandSchema.safeParse({ ...base, idempotencyKey: 'not-a-uuid' }).success).toBe(false);
    expect(ClientCommandSchema.safeParse({ ...base, displayName: '   ' }).success).toBe(false);
    expect(ClientCommandSchema.safeParse({ ...base, providerId: '' }).success).toBe(false);
    expect(ClientCommandSchema.safeParse({ ...base, modelId: '' }).success).toBe(false);
    expect(ClientCommandSchema.safeParse({ ...base, channelIds: Array.from({ length: 21 }, (_, i) => `channel-${i}`) }).success).toBe(false);
  });
});
