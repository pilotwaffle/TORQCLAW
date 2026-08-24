'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClientCommand, GatewayEvent } from '@torqclaw/contracts';

interface AgentRecord {
  principalId: string;
  displayName: string;
  status: string;
  providerId: string;
  modelId: string;
  channels: Array<{ channelId: string; channelName: string }>;
  iconId?: AgentIconId;
  systemDirectives?: string;
  personaRevision?: number;
  autostart?: boolean;
  externalContextConfirmed?: boolean;
  /** G1D channels-agent-UX packet (2026-08-24) Item C: server-computed via
   *  the EXACT runtimeProfileAllowsAutomaticTurn predicate
   *  (autoReplyDispatcher.ts), never re-derived client-side (B-5). Channel-
   *  scoped gates (STOP, export policy) are not evaluable in this
   *  fleet-wide roster, so this reflects "configuration readiness," never
   *  a per-channel "will respond" guarantee. */
  configurationReadiness?: 'live' | 'parked';
}

type AgentIconId = 'robot' | 'brain' | 'shield' | 'search' | 'code' | 'spark' | 'bolt' | 'target';
const AGENT_ICONS: Array<{ id: AgentIconId; glyph: string; label: string }> = [
  { id: 'robot', glyph: '🤖', label: 'Robot' },
  { id: 'brain', glyph: '🧠', label: 'Brain' },
  { id: 'shield', glyph: '🛡️', label: 'Shield' },
  { id: 'search', glyph: '🔎', label: 'Search' },
  { id: 'code', glyph: '💻', label: 'Code' },
  { id: 'spark', glyph: '✦', label: 'Spark' },
  { id: 'bolt', glyph: '⚡', label: 'Bolt' },
  { id: 'target', glyph: '🎯', label: 'Target' },
];

function iconFor(iconId: AgentIconId | undefined): string {
  return AGENT_ICONS.find((icon) => icon.id === iconId)?.glyph ?? AGENT_ICONS[0]!.glyph;
}

interface ProviderRecord {
  id: string;
  label: string;
  status: 'connected' | 'available' | 'missing' | 'unavailable';
  executionReady: boolean;
  authKind: 'none' | 'external_cli_session';
  models: Array<{ id: string; label: string; executionReady: boolean; note: string }>;
  note: string;
}

interface ChannelRecord {
  channelId: string;
  name: string;
}

interface AgentsPanelProps {
  events: GatewayEvent[];
  sendCommand: (command: ClientCommand) => boolean;
  onClose: () => void;
}

function metadataOf(event: GatewayEvent): Record<string, unknown> {
  const candidate = (event as GatewayEvent & { metadata?: unknown }).metadata;
  return candidate && typeof candidate === 'object' ? candidate as Record<string, unknown> : {};
}

function latestArray<T>(events: GatewayEvent[], marker: string, field: string): T[] | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const metadata = metadataOf(events[index]!);
    if (metadata[marker] === true && Array.isArray(metadata[field])) return metadata[field] as T[];
  }
  return null;
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || 'A';
}

export default function AgentsPanel({ events, sendCommand, onClose }: AgentsPanelProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [providerId, setProviderId] = useState('ollama-local');
  const [modelId, setModelId] = useState('');
  const [channelIds, setChannelIds] = useState<string[]>([]);
  const [autostart, setAutostart] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [editingAgent, setEditingAgent] = useState<AgentRecord | null>(null);
  const [editIconId, setEditIconId] = useState<AgentIconId>('robot');
  const [editSystemDirectives, setEditSystemDirectives] = useState('');
  const [editReconfirmExternalContext, setEditReconfirmExternalContext] = useState(false);
  const handledMutationId = useRef<string | null>(null);
  const [pendingMutation, setPendingMutation] = useState<{ operation: 'create' | 'update' | 'autostart'; idempotencyKey: string } | null>(null);
  const [testingConnection, setTestingConnection] = useState(false);
  const createDialogRef = useRef<HTMLDivElement>(null);
  const editDialogRef = useRef<HTMLDivElement>(null);
  const createInitialRef = useRef<HTMLInputElement>(null);
  const editInitialRef = useRef<HTMLTextAreaElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    sendCommand({ action: 'LIST_AGENTS', limit: 50 });
    sendCommand({ action: 'LIST_AGENT_PROVIDERS' });
    sendCommand({ action: 'LIST_CHANNELS', limit: 100 });
  }, [sendCommand]);

  const agents = useMemo(() => latestArray<AgentRecord>(events, 'collabAgents', 'agents'), [events]);
  const providers = useMemo(() => latestArray<ProviderRecord>(events, 'agentProviders', 'providers'), [events]);
  const channels = useMemo(() => latestArray<ChannelRecord>(events, 'collabChannels', 'channels') ?? [], [events]);
  const selectedProvider = providers?.find((provider) => provider.id === providerId) ?? providers?.[0];
  const selectedModel = selectedProvider?.models.find((model) => model.id === modelId);
  const usesExternalContext = selectedProvider?.authKind === 'external_cli_session';
  // The editor must reflect the LIVE roster entry, not the snapshot taken at
  // open time -- a SET_LOCAL_AGENT_AUTOSTART round trip refreshes `agents`
  // via LIST_AGENTS, and the toggle must show that result without the
  // editor being closed and reopened.
  const liveEditingAgent = editingAgent
    ? agents?.find((agent) => agent.principalId === editingAgent.principalId) ?? editingAgent
    : null;
  const selectedProviderForEditingAgent = liveEditingAgent
    ? providers?.find((provider) => provider.id === liveEditingAgent.providerId)
    : undefined;

  const closeDialogs = useCallback(() => {
    setDialogOpen(false);
    setEditingAgent(null);
    queueMicrotask(() => returnFocusRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!selectedProvider) return;
    if (!selectedProvider.models.some((model) => model.id === modelId)) {
      setModelId(selectedProvider.models[0]?.id ?? '');
    }
  }, [modelId, selectedProvider]);

  useEffect(() => {
    if (!pendingMutation) return;
    const mutation = [...events].reverse().find((event) => {
      const metadata = metadataOf(event);
      return metadata.agentMutationTerminal === true
        && metadata.operation === pendingMutation.operation
        && metadata.idempotencyKey === pendingMutation.idempotencyKey;
    });
    if (!mutation || handledMutationId.current === mutation.id) return;
    const metadata = metadataOf(mutation);
    handledMutationId.current = mutation.id;
    setPendingMutation(null);
    if (metadata.status === 'error') {
      const failures = Array.isArray(metadata.membershipResults)
        ? metadata.membershipResults.filter((entry): entry is { channelId: string; ok: false; error?: string } => {
          return typeof entry === 'object' && entry !== null && (entry as { ok?: unknown }).ok === false;
        })
        : [];
      const channelSummary = failures.map((failure) => failure.channelId).join(', ');
      setSubmitError(`${String(metadata.message ?? 'Agent mutation failed.')}${channelSummary ? ` Failed channels: ${channelSummary}.` : ''}`);
      return;
    }
    if (metadata.status === 'conflict') {
      setSubmitError(String(metadata.message ?? 'Agent profile changed elsewhere. Close and reopen the editor.'));
      return;
    }
    if (metadata.status !== 'success') {
      setSubmitError('The gateway returned an invalid agent mutation result.');
      return;
    }
    sendCommand({ action: 'LIST_AGENTS', limit: 50 });
    if (pendingMutation.operation === 'autostart') {
      // Local-agent autostart is a toggle inside the still-open editor, not
      // a create/update that should close the drawer -- mirrors the pattern
      // above, but deliberately does not call closeDialogs().
      return;
    }
    setDisplayName('');
    setChannelIds([]);
    closeDialogs();
  }, [closeDialogs, events, pendingMutation, sendCommand]);

  useEffect(() => {
    const root = dialogOpen ? createDialogRef.current : editingAgent ? editDialogRef.current : null;
    if (!root) return;
    (dialogOpen ? createInitialRef.current : editInitialRef.current)?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !pendingMutation) {
        event.preventDefault();
        closeDialogs();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )];
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    root.addEventListener('keydown', onKeyDown);
    return () => root.removeEventListener('keydown', onKeyDown);
  }, [dialogOpen, editingAgent, pendingMutation]);

  const createAgent = () => {
    if (!selectedProvider?.executionReady || !selectedModel?.executionReady) {
      setSubmitError('This subscription adapter is not ready for TORQClaw execution yet.');
      return;
    }
    if (usesExternalContext && autostart) {
      setSubmitError('Create the external agent first, then explicitly confirm its exact persona and runtime.');
      return;
    }
    const idempotencyKey = crypto.randomUUID();
    const sent = sendCommand({
      action: 'CREATE_AGENT',
      displayName: displayName.trim(),
      providerId: selectedProvider.id,
      modelId,
      autostart,
      externalContextConfirmed: false,
      channelIds,
      idempotencyKey,
    });
    setPendingMutation(sent ? { operation: 'create', idempotencyKey } : null);
    setSubmitError(sent ? null : 'The gateway connection is not open.');
  };

  const openAgentEditor = (agent: AgentRecord) => {
    returnFocusRef.current = document.activeElement as HTMLElement | null;
    setEditingAgent(agent);
    setEditIconId(agent.iconId ?? 'robot');
    setEditSystemDirectives(agent.systemDirectives ?? '');
    setEditReconfirmExternalContext(false);
    setSubmitError(null);
  };

  const updateAgentProfile = () => {
    if (!editingAgent) return;
    const idempotencyKey = crypto.randomUUID();
    const sent = sendCommand({
      action: 'UPDATE_AGENT_PROFILE',
      agentPrincipalId: editingAgent.principalId,
      iconId: editIconId,
      systemDirectives: editSystemDirectives.trim(),
      expectedRevision: editingAgent.personaRevision ?? 0,
      reconfirmExternalContext: editReconfirmExternalContext,
      idempotencyKey,
    });
    setPendingMutation(sent ? { operation: 'update', idempotencyKey } : null);
    setSubmitError(sent ? null : 'The gateway connection is not open.');
  };

  const toggleLocalAutostart = (nextAutostart: boolean) => {
    if (!liveEditingAgent || liveEditingAgent.providerId !== 'ollama-local') return;
    const idempotencyKey = crypto.randomUUID();
    const sent = sendCommand({
      action: 'SET_LOCAL_AGENT_AUTOSTART',
      agentPrincipalId: liveEditingAgent.principalId,
      autostart: nextAutostart,
      idempotencyKey,
    });
    setPendingMutation(sent ? { operation: 'autostart', idempotencyKey } : null);
    setSubmitError(sent ? null : 'The gateway connection is not open.');
  };

  const testConnection = () => {
    setTestingConnection(true);
    sendCommand({ action: 'LIST_AGENT_PROVIDERS' });
  };

  useEffect(() => {
    if (!testingConnection || !providers) return;
    setTestingConnection(false);
  }, [providers, testingConnection]);

  const moveIconSelection = (current: AgentIconId, delta: number) => {
    const index = AGENT_ICONS.findIndex((icon) => icon.id === current);
    const next = AGENT_ICONS[(index + delta + AGENT_ICONS.length) % AGENT_ICONS.length]!;
    setEditIconId(next.id);
    queueMicrotask(() => editDialogRef.current
      ?.querySelector<HTMLInputElement>(`input[name="agent-icon"][value="${next.id}"]`)?.focus());
  };

  return (
    <section className="relative flex h-full min-h-0 flex-col bg-panel" aria-label="Agents fleet">
      <header className="flex items-center justify-between border-b border-white/10 px-5 py-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-torque">Fleet control</p>
          <h2 className="mt-1 text-xl font-semibold text-ink">Agents</h2>
        </div>
        <button type="button" onClick={onClose} className="rounded-lg border border-white/10 px-3 py-2 text-sm text-muted hover:text-ink">Close</button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          <button type="button" onClick={(event) => { returnFocusRef.current = event.currentTarget; setDialogOpen(true); setSubmitError(null); }} className="group min-h-64 rounded-2xl border border-dashed border-torque/50 bg-torque/5 p-5 text-left transition hover:-translate-y-0.5 hover:border-torque hover:bg-torque/10" aria-label="New agent">
            <span className="grid h-14 w-14 place-items-center rounded-2xl bg-torque text-3xl text-black">+</span>
            <span className="mt-14 block text-lg font-semibold text-ink">Add agent</span>
            <span className="mt-2 block text-sm leading-6 text-muted">Create a managed teammate and assign its channels.</span>
          </button>

          {agents?.map((agent) => (
            <button type="button" key={agent.principalId} onClick={() => openAgentEditor(agent)} aria-label={`Edit ${agent.displayName}`} className="relative min-h-64 rounded-2xl border border-white/10 bg-panel-2 p-5 text-left shadow-xl shadow-black/10 transition hover:-translate-y-0.5 hover:border-torque/50">
              <div className="flex items-start justify-between">
                <div className="grid h-20 w-20 place-items-center rounded-full border border-white/10 bg-gradient-to-br from-torque/70 to-amber-700 text-3xl text-black" title={initials(agent.displayName)}>{iconFor(agent.iconId)}</div>
                <div className="flex flex-col items-end gap-1.5">
                  <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${agent.status === 'active' ? 'bg-emerald-400/15 text-emerald-300' : 'bg-red-400/15 text-red-300'}`}>{agent.status}</span>
                  {/* Operator-only configuration readiness (G1D packet Item C, B-4(b)/B-5): never a co-member-visible field, never claims a per-channel guarantee. */}
                  <span
                    title="Configuration readiness only -- per-channel conditions (STOP, export policy) are not shown here."
                    className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${agent.configurationReadiness === 'live' ? 'bg-torque/15 text-torque' : 'bg-white/5 text-muted'}`}
                  >
                    {agent.configurationReadiness === 'live' ? 'Live' : 'Parked'}
                  </span>
                </div>
              </div>
              <h3 className="mt-9 truncate text-lg font-semibold text-ink">{agent.displayName}</h3>
              <p className="mt-1 truncate text-xs text-muted">{agent.modelId}</p>
              <div className="mt-4 flex flex-wrap gap-1.5">
                {agent.channels.length > 0 ? agent.channels.map((channel) => <span key={channel.channelId} className="rounded-md bg-white/5 px-2 py-1 text-[11px] text-muted">#{channel.channelName}</span>) : <span className="text-[11px] text-muted">No channels assigned</span>}
              </div>
            </button>
          ))}
        </div>
        {agents === null && <p className="mt-5 text-sm text-muted">Loading agent roster...</p>}
      </div>

      {dialogOpen && (
        <div ref={createDialogRef} className="absolute inset-0 z-30 flex justify-end bg-black/65" role="dialog" aria-modal="true" aria-labelledby="agent-dialog-title">
          <div className="h-full w-full max-w-lg overflow-y-auto border-l border-white/10 bg-panel p-6 shadow-2xl">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-torque">New teammate</p>
                <h3 id="agent-dialog-title" className="mt-1 text-2xl font-semibold text-ink">Configure agent</h3>
              </div>
              <button type="button" disabled={Boolean(pendingMutation)} onClick={closeDialogs} className="rounded-lg px-3 py-2 text-muted hover:bg-white/5 hover:text-ink disabled:opacity-40">Cancel</button>
            </div>

            <label className="mt-8 block text-sm font-medium text-ink">Name
              <input ref={createInitialRef} value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={80} className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-ink outline-none focus:border-torque" placeholder="Research Scout" />
            </label>
            <label className="mt-5 block text-sm font-medium text-ink">Provider account
              <select value={providerId} onChange={(event) => { setProviderId(event.target.value); setAutostart(false); }} className="mt-2 w-full rounded-xl border border-white/10 bg-panel-2 px-4 py-3 text-ink outline-none focus:border-torque">
                {providers?.map((provider) => <option key={provider.id} value={provider.id}>{provider.label} - {provider.status}</option>)}
              </select>
            </label>
            {selectedProvider && <div className={`mt-3 rounded-xl border p-3 text-xs leading-5 ${selectedProvider.executionReady ? 'border-emerald-400/20 bg-emerald-400/5 text-emerald-200' : 'border-amber-400/20 bg-amber-400/5 text-amber-100'}`}>{selectedProvider.note}</div>}
            <label className="mt-5 block text-sm font-medium text-ink">Model
              <select value={modelId} onChange={(event) => setModelId(event.target.value)} className="mt-2 w-full rounded-xl border border-white/10 bg-panel-2 px-4 py-3 text-ink outline-none focus:border-torque">
                {selectedProvider?.models.map((model) => <option key={model.id} value={model.id}>{model.label}{model.executionReady ? '' : ' - disabled'}</option>)}
              </select>
            </label>
            {selectedModel && !selectedModel.executionReady && <p className="mt-2 text-xs text-amber-100">{selectedModel.note}</p>}
            <fieldset className="mt-6">
              <legend className="text-sm font-medium text-ink">Channels</legend>
              <div className="mt-3 grid grid-cols-2 gap-2">
                {channels.map((channel) => <label key={channel.channelId} className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-muted"><input type="checkbox" checked={channelIds.includes(channel.channelId)} onChange={(event) => setChannelIds((current) => event.target.checked ? [...current, channel.channelId] : current.filter((value) => value !== channel.channelId))} />#{channel.name}</label>)}
              </div>
            </fieldset>
            <label className="mt-5 flex items-start gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-3 text-sm text-muted">
              <input type="checkbox" checked={autostart} disabled={usesExternalContext} onChange={(event) => setAutostart(event.target.checked)} className="mt-1" />
              <span><strong className="block text-ink">Enable automatic replies</strong>{usesExternalContext ? 'External agents are created inactive. Open the saved profile to bind explicit consent to its exact persona and runtime.' : 'Enable managed local channel replies.'}</span>
            </label>
            {submitError && <p role="alert" aria-live="assertive" className="mt-5 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">{submitError}</p>}
            <button type="button" disabled={Boolean(pendingMutation) || !displayName.trim() || !modelId || !selectedProvider?.executionReady || !selectedModel?.executionReady || (usesExternalContext && autostart)} onClick={createAgent} className="mt-7 w-full rounded-xl bg-torque px-4 py-3 font-semibold text-black disabled:cursor-not-allowed disabled:opacity-40">{pendingMutation?.operation === 'create' ? 'Adding agent...' : 'Add agent'}</button>
          </div>
        </div>
      )}

      {editingAgent && (
        <div ref={editDialogRef} className="absolute inset-0 z-30 flex justify-end bg-black/65" role="dialog" aria-modal="true" aria-labelledby="edit-agent-dialog-title">
          <div className="h-full w-full max-w-lg overflow-y-auto border-l border-white/10 bg-panel p-6 shadow-2xl">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-torque">Agent profile</p>
                <h3 id="edit-agent-dialog-title" className="mt-1 text-2xl font-semibold text-ink">{editingAgent.displayName}</h3>
                <p className="mt-1 text-xs text-muted">{editingAgent.modelId}</p>
              </div>
              <button type="button" disabled={Boolean(pendingMutation)} onClick={closeDialogs} className="rounded-lg px-3 py-2 text-muted hover:bg-white/5 hover:text-ink disabled:opacity-40">Cancel</button>
            </div>

            <fieldset className="mt-8">
              <legend className="text-sm font-medium text-ink">Agent icon</legend>
              <div className="mt-3 grid grid-cols-4 gap-3">
                {AGENT_ICONS.map((icon) => (
                  <label key={icon.id} className={`grid cursor-pointer place-items-center rounded-xl border p-3 ${editIconId === icon.id ? 'border-torque bg-torque/10' : 'border-white/10 bg-white/[0.03]'}`}>
                    <input type="radio" name="agent-icon" value={icon.id} checked={editIconId === icon.id} onChange={() => setEditIconId(icon.id)} onKeyDown={(event) => { if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); moveIconSelection(icon.id, 1); } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { event.preventDefault(); moveIconSelection(icon.id, -1); } }} className="sr-only" aria-label={icon.label} />
                    <span className="text-3xl" aria-hidden="true">{icon.glyph}</span>
                    <span className="mt-2 text-[11px] text-muted">{icon.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <section className="mt-7 rounded-2xl border border-white/10 bg-white/[0.025] p-4" aria-labelledby="agent-instructions-label">
              <div>
                <h4 id="agent-instructions-label" className="text-sm font-semibold text-ink">Agent instructions</h4>
                <p className="mt-1 text-xs leading-5 text-muted">Set this agent's role, priorities, response style, and operating boundaries.</p>
              </div>
              <label className="mt-4 block text-xs font-medium uppercase tracking-[0.16em] text-muted">Instructions
              <textarea ref={editInitialRef} value={editSystemDirectives} onChange={(event) => setEditSystemDirectives(event.target.value)} maxLength={4000} rows={12} className="mt-2 w-full resize-y rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-ink outline-none focus:border-torque" placeholder="Define this agent's role, priorities, tone, and boundaries." />
              </label>
              <div className="mt-2 flex justify-between text-xs text-muted">
                <span>Applied as system-level guidance to automatic channel turns. Do not include secrets.</span>
                <span>{editSystemDirectives.length}/4000</span>
              </div>
            </section>
            <section className="mt-7 rounded-2xl border border-white/10 bg-white/[0.025] p-4" aria-labelledby="agent-enablement-label">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h4 id="agent-enablement-label" className="text-sm font-semibold text-ink">Enable this agent to respond</h4>
                  <p className="mt-1 text-xs leading-5 text-muted">
                    {liveEditingAgent?.providerId === 'ollama-local'
                      ? 'Local agents run on this machine. Flip this on to let it answer automatically in its assigned channels.'
                      : 'Re-binds consent to the CURRENT provider, model, and persona snapshot below -- required every time the persona changes.'}
                  </p>
                </div>
                <button type="button" onClick={testConnection} disabled={testingConnection} className="shrink-0 rounded-lg border border-white/10 px-3 py-2 text-xs font-semibold text-muted hover:text-ink disabled:opacity-40">
                  {testingConnection ? 'Testing...' : 'Test connection'}
                </button>
              </div>
              {selectedProviderForEditingAgent && (
                <div className={`mt-3 rounded-xl border p-3 text-xs leading-5 ${selectedProviderForEditingAgent.executionReady ? 'border-emerald-400/20 bg-emerald-400/5 text-emerald-200' : 'border-amber-400/20 bg-amber-400/5 text-amber-100'}`}>
                  {selectedProviderForEditingAgent.note}
                </div>
              )}
              {liveEditingAgent?.providerId === 'ollama-local' && (
                <label className="mt-4 flex items-start gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-3 text-sm text-muted">
                  <input
                    type="checkbox"
                    checked={liveEditingAgent.autostart === true}
                    disabled={Boolean(pendingMutation)}
                    onChange={(event) => toggleLocalAutostart(event.target.checked)}
                    className="mt-1"
                  />
                  <span><strong className="block text-ink">Enable automatic replies</strong>Applies immediately -- no persona save required.</span>
                </label>
              )}
            </section>
            {editingAgent.providerId !== 'ollama-local' && (
              <label className="mt-5 flex items-start gap-3 rounded-xl border border-amber-400/25 bg-amber-400/5 p-3 text-sm text-amber-100">
                <input type="checkbox" checked={editReconfirmExternalContext} onChange={(event) => setEditReconfirmExternalContext(event.target.checked)} className="mt-1" />
                <span><strong className="block text-ink">Reconfirm external context and enable replies</strong>I understand this exact canonical persona and channel context will leave this machine through {editingAgent.providerId} / {editingAgent.modelId}. Consent is atomically bound to the exact model and runtime fingerprint. Grok retains vendor built-in tool and OS-process risk.</span>
              </label>
            )}
            {submitError && <p role="alert" aria-live="assertive" className="mt-5 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">{submitError}</p>}
            <button type="button" disabled={Boolean(pendingMutation)} onClick={updateAgentProfile} className="mt-7 w-full rounded-xl bg-torque px-4 py-3 font-semibold text-black disabled:opacity-40">{pendingMutation?.operation === 'update' ? 'Saving profile...' : 'Save agent profile'}</button>
          </div>
        </div>
      )}
    </section>
  );
}
