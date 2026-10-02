'use client';

import { useEffect, useMemo, useState } from 'react';
import type { RoomJobArtifactContent, RoomJobExecutionDetail, RoomJobListEntry, RoomJobDetail } from './roomJobView';
import { isCurrentRoomJobArtifact, visibleRoomJobDetail } from './roomJobView';

export interface RoomJobWorkspaceProps {
  roomName: string;
  jobs: RoomJobListEntry[] | null;
  selectedJobId: string | null;
  detail: RoomJobDetail | null;
  listStatus: 'idle' | 'loading' | 'send-failed' | 'timeout' | 'unavailable';
  detailStatus: 'idle' | 'loading' | 'send-failed' | 'timeout' | 'unavailable';
  connected: boolean;
  stale: boolean;
  onSelectJob: (jobId: string) => void;
  onRefreshList: () => void;
  onRefreshDetail: () => void;
  execution?: RoomJobExecutionDetail | null;
  executionArtifact?: RoomJobArtifactContent | null;
  executionArtifactStatus?: 'idle' | 'loading' | 'send-failed' | 'timeout' | 'unavailable';
  executionActions?: RoomJobExecutionActions;
}

export interface RoomJobExecutionActions {
  onAddFacts: (facts: string[]) => void;
  onStart: (factIds: string[]) => void;
  onReadArtifact: (artifactId: string) => void;
  onRefresh: () => void;
}

export interface RoomJobControlsProps {
  connected: boolean;
  stale: boolean;
  canCreate: boolean;
  canCancel: boolean;
  selectedJobId: string | null;
  mutationStatus: 'idle' | 'create-pending' | 'cancel-pending' | 'facts-pending' | 'start-pending' | 'unconfirmed';
  onCreate: (brief: string) => void;
  onCancel: () => void;
  onRefresh: () => void;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function lifecycleLabel(kind: RoomJobDetail['lifecycle'][number]['kind']): string {
  if (kind === 'created') return 'Recorded - no live worker is wired.';
  if (kind === 'cancel_requested') return 'Cancellation requested.';
  if (kind === 'cancelled') return 'Cancelled - no task or external action is claimed stopped.';
  return 'Artifact metadata recorded.';
}

export default function RoomJobWorkspace({
  roomName, jobs, selectedJobId, detail, listStatus, detailStatus, connected,
  stale, onSelectJob, onRefreshList, onRefreshDetail, execution, executionArtifact,
  executionArtifactStatus, executionActions,
}: RoomJobWorkspaceProps) {
  const visibleDetail = useMemo(() => detail ? visibleRoomJobDetail(detail) : null, [detail]);
  const listMessage = !connected
    ? 'Disconnected. Last confirmed Room jobs may be stale.'
    : stale
      ? 'Connection is stale. Job actions are disabled.'
      : listStatus === 'loading'
        ? 'Loading Room jobs...'
        : listStatus === 'timeout'
          ? 'Room jobs request was not confirmed. Refresh from the gateway.'
          : listStatus === 'send-failed'
            ? 'Room jobs request could not be sent.'
            : 'Server-authorized Room jobs only.';

  return (
    <section className="border-b border-edge py-4" aria-labelledby="room-jobs-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 id="room-jobs-heading" className="text-[11px] font-semibold text-ink">Room jobs</h3>
          <p className="mt-1 text-[10.5px] text-faint" role="status">{listMessage}</p>
        </div>
        <button type="button" onClick={onRefreshList} disabled={!connected || stale || listStatus === 'loading'} className="text-[10.5px] underline decoration-edge underline-offset-4 hover:text-ink disabled:opacity-50">
          refresh jobs
        </button>
      </div>

      {jobs === null ? (
        <p className="mt-3 text-[10.5px] text-faint">Room jobs unknown/not loaded.</p>
      ) : jobs.length === 0 ? (
        <p className="mt-3 text-[10.5px] text-faint">No Room jobs recorded.</p>
      ) : (
        <ul className="mt-3 divide-y divide-edge border-y border-edge" aria-label={`${roomName} Room jobs`}>
          {jobs.map((job) => (
            <li key={job.jobId}>
              <button type="button" onClick={() => onSelectJob(job.jobId)} aria-pressed={selectedJobId === job.jobId} className={`w-full px-2 py-2 text-left text-[10.5px] ${selectedJobId === job.jobId ? 'bg-panel-2 text-ink' : 'text-muted hover:bg-panel-2/60 hover:text-ink'}`}>
                <span className="block truncate font-medium">Job {job.jobId}</span>
                <span className="block text-faint">{job.state} - revision {job.revision} - brief {job.briefByteLength} bytes</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 border-t border-edge pt-4" aria-labelledby="room-job-detail-heading">
        <div className="flex items-center justify-between gap-2">
          <h4 id="room-job-detail-heading" className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted">Job timeline</h4>
          {selectedJobId && <button type="button" onClick={onRefreshDetail} disabled={!connected || stale || detailStatus === 'loading'} className="text-[10px] underline decoration-edge underline-offset-4 hover:text-ink disabled:opacity-50">refresh detail</button>}
        </div>
        {!selectedJobId ? <p className="mt-2 text-[10.5px] text-faint">Select a listed job to load its server-ordered evidence.</p>
          : detailStatus === 'loading' ? <p className="mt-2 text-[10.5px] text-faint" role="status">Loading job detail...</p>
            : detailStatus !== 'idle' ? <p className="mt-2 text-[10.5px] text-faint" role="status">Job detail unknown/not loaded.</p>
              : visibleDetail ? (
                <div className="mt-2 space-y-3">
                  <ol className="space-y-2" aria-label="Job lifecycle evidence">
                    {visibleDetail.lifecycle.map((entry) => <li key={entry.jobSeq} className="border-l-2 border-edge pl-3 text-[10.5px] text-muted"><span className="block font-medium text-ink">{lifecycleLabel(entry.kind)}</span><span className="text-faint">evidence {entry.jobSeq} - revision {entry.revision} - {entry.occurredAt}</span></li>)}
                  </ol>
                  <div>
                    <p className="text-[9px] font-bold uppercase tracking-[0.1em] text-faint">Immutable artifact metadata</p>
                    {visibleDetail.artifacts.length === 0 ? <p className="mt-1 text-[10.5px] text-faint">Artifact metadata unknown/not loaded.</p> : (
                      <ul className="mt-2 space-y-1">{visibleDetail.artifacts.map((artifact) => <li key={artifact.artifactId} className="text-[10.5px] text-muted">{artifact.artifactType} revision {artifact.revision} - sha256 {artifact.sha256.slice(0, 12)}... - {artifact.provenanceKind}</li>)}</ul>
                    )}
                  </div>
                  {(execution === null || execution === undefined) && <p className="text-[10px] text-faint">Preview and download unavailable under this foundation contract.</p>}
                </div>
              ) : <p className="mt-2 text-[10.5px] text-faint">Job detail unknown/not loaded.</p>}
        {execution !== null && execution !== undefined && executionActions !== undefined && (
          <RoomJobExecutionWorkspace detail={execution} artifact={executionArtifact ?? null} artifactStatus={executionArtifactStatus} actions={executionActions} />
        )}
      </div>

    </section>
  );
}

export function RoomJobControls({ connected, stale, canCreate, canCancel, selectedJobId, mutationStatus, onCreate, onCancel, onRefresh }: RoomJobControlsProps) {
  const [brief, setBrief] = useState('');
  const bytes = byteLength(brief);
  const controlsFresh = connected && !stale;
  const mutationPending = mutationStatus === 'create-pending' || mutationStatus === 'cancel-pending' || mutationStatus === 'facts-pending' || mutationStatus === 'start-pending';
  const canSubmit = controlsFresh && canCreate && !mutationPending && bytes >= 1 && bytes <= 16384;
  const canCancelNow = controlsFresh && canCancel && !mutationPending;

  return (
    <div className="border-b border-edge py-4" aria-labelledby="room-job-controls-heading">
      <h3 id="room-job-controls-heading" className="text-[9px] font-bold uppercase tracking-[0.1em] text-faint">Job controls</h3>
      {canCreate ? (
        <div className="mt-2 space-y-2">
          <label className="block text-[10.5px] text-muted" htmlFor="room-job-brief">Client brief</label>
          <textarea id="room-job-brief" value={brief} onChange={(event) => setBrief(event.target.value)} maxLength={16384} rows={3} className="w-full resize-y rounded border border-edge bg-panel-2 px-2 py-1.5 text-[11px] text-ink outline-none focus:border-torque" />
          <p className="text-[10px] text-faint">{bytes} / 16384 UTF-8 bytes. The gateway normalizes and validates the brief.</p>
          <button type="button" onClick={() => { onCreate(brief); setBrief(''); }} disabled={!canSubmit} className="rounded border border-torque/40 px-2 py-1 text-[10.5px] text-torque hover:bg-torque/10 disabled:opacity-50">Create proposal job</button>
        </div>
      ) : <p className="mt-2 text-[10.5px] text-faint">Job actions unavailable with the current Room capability.</p>}
      {selectedJobId && <div className="mt-3"><button type="button" onClick={onCancel} disabled={!canCancelNow} className="rounded border border-bad/40 px-2 py-1 text-[10.5px] text-bad hover:bg-bad/10 disabled:opacity-50">Cancel job</button></div>}
      {mutationStatus === 'create-pending' && <p className="mt-2 text-[10px] text-faint" role="status">Creation request pending confirmation.</p>}
      {mutationStatus === 'cancel-pending' && <p className="mt-2 text-[10px] text-faint" role="status">Cancellation request pending confirmation.</p>}
      {mutationStatus === 'unconfirmed' && <p className="mt-2 text-[10px] text-faint" role="status">Request not confirmed. <button type="button" onClick={onRefresh} disabled={!controlsFresh} className="underline decoration-edge underline-offset-4 disabled:opacity-50">Refresh from the gateway.</button></p>}
    </div>
  );
}

function executionStateLabel(attempt: RoomJobExecutionDetail['execution']['latestAttempt']): string {
  if (attempt === null) return 'No local execution attempt is recorded.';
  if (attempt.state === 'queued') return 'Local draft is queued.';
  if (attempt.state === 'draft_committed') return 'Validated draft recorded; configured review pending.';
  if (attempt.state === 'review_committed' || attempt.state === 'completed_internal') return 'Validated proposal and configured review recorded. No delivery, approval, receipt, or external action occurred.';
  if (attempt.terminalCode === 'stage_failed') return 'Configured local execution failed. No unvalidated output is available.';
  if (attempt.state === 'runtime_unavailable') return 'Configured local runtime is unavailable. Nothing was started.';
  if (attempt.state === 'validation_failed') return 'Output did not pass validation. No proposal/review was recorded from that stage.';
  if (attempt.state === 'recovery_needed') return 'Execution outcome needs server recovery. Do not start again from this screen.';
  return 'Cancelled. No task or external action is claimed stopped.';
}

function factLines(value: string): string[] {
  return value.split('\n');
}

function validFacts(facts: string[]): boolean {
  return facts.length >= 1 && facts.length <= 20 && facts.every((fact) => {
    const bytes = byteLength(fact);
    return bytes >= 1 && bytes <= 16384;
  });
}

async function contentSha256(content: string): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function RoomJobExecutionWorkspace({
  detail, artifact, artifactStatus = 'idle', mutationStatus = 'idle', actions,
}: {
  detail: RoomJobExecutionDetail;
  artifact: RoomJobArtifactContent | null;
  artifactStatus?: 'idle' | 'loading' | 'send-failed' | 'timeout' | 'unavailable';
  mutationStatus?: 'idle' | 'facts-pending' | 'start-pending' | 'unconfirmed';
  actions: RoomJobExecutionActions;
}) {
  const [factDraft, setFactDraft] = useState('');
  const [selectedFactIds, setSelectedFactIds] = useState<string[]>([]);
  const [verified, setVerified] = useState<RoomJobArtifactContent | null>(null);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [downloadStatus, setDownloadStatus] = useState<'idle' | 'downloaded' | 'failed'>('idle');
  const facts = factLines(factDraft);
  const mutationPending = mutationStatus === 'facts-pending' || mutationStatus === 'start-pending';
  const canAddFacts = detail.execution.capabilities.canAddFacts && !mutationPending;
  const canStart = detail.execution.capabilities.canStart && selectedFactIds.length > 0 && !mutationPending;
  const readableArtifacts = detail.job.artifacts.filter((item) =>
    item.provenanceKind === 'model_assertion' && (item.artifactType === 'proposal' || item.artifactType === 'decision_summary'),
  );

  useEffect(() => {
    setSelectedFactIds((current) => current.filter((id) => detail.execution.facts?.some((fact) => fact.factId === id) === true));
  }, [detail.execution.facts]);

  useEffect(() => {
    let disposed = false;
    setVerified(null);
    setCopyStatus('idle');
    setDownloadStatus('idle');
    if (artifact === null || !isCurrentRoomJobArtifact(detail, artifact)) return;
    void contentSha256(artifact.content).then((hash) => {
      if (!disposed && hash === artifact.sha256) setVerified(artifact);
    }).catch(() => undefined);
    return () => { disposed = true; };
  }, [artifact, detail]);

  const submitFacts = () => {
    if (!canAddFacts || !validFacts(facts)) return;
    actions.onAddFacts(facts);
    setFactDraft('');
  };

  const toggleFact = (factId: string) => {
    setSelectedFactIds((current) => current.includes(factId) ? current.filter((id) => id !== factId) : [...current, factId]);
  };

  const copyArtifact = async () => {
    if (verified === null || !navigator.clipboard) { setCopyStatus('failed'); return; }
    try {
      await navigator.clipboard.writeText(verified.content);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('failed');
    }
  };

  const downloadArtifact = () => {
    if (verified === null) { setDownloadStatus('failed'); return; }
    try {
      const blob = new Blob([verified.content], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `room-job-${verified.artifactType}-r${verified.revision}.json`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setDownloadStatus('downloaded');
    } catch {
      setDownloadStatus('failed');
    }
  };

  return (
    <section className="border-t border-edge pt-4" aria-labelledby="room-job-execution-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 id="room-job-execution-heading" className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted">Local draft and configured review</h4>
          <p className="mt-1 text-[10.5px] text-faint" role="status">{executionStateLabel(detail.execution.latestAttempt)}</p>
        </div>
        <button type="button" onClick={actions.onRefresh} className="text-[10px] underline decoration-edge underline-offset-4 hover:text-ink">refresh execution</button>
      </div>
      <p className="mt-2 text-[10px] text-faint">Runtime: {detail.execution.capabilities.runtime}. Observed by the server at {detail.execution.observedAt}.</p>
      {mutationStatus === 'facts-pending' && <p className="mt-2 text-[10px] text-faint" role="status">Facts request pending confirmation.</p>}
      {mutationStatus === 'start-pending' && <p className="mt-2 text-[10px] text-faint" role="status">Start request pending confirmation.</p>}
      {mutationStatus === 'unconfirmed' && <p className="mt-2 text-[10px] text-faint" role="status">Request not confirmed. Refresh execution from the gateway.</p>}

      {detail.execution.facts !== undefined && (
        <div className="mt-4 border-t border-edge pt-3">
          <p className="text-[9px] font-bold uppercase tracking-[0.1em] text-faint">Owner-supplied facts</p>
          {canAddFacts && <div className="mt-2 space-y-2">
            <label className="block text-[10.5px] text-muted" htmlFor="room-job-facts">One plain-text fact per line</label>
            <textarea id="room-job-facts" value={factDraft} onChange={(event) => setFactDraft(event.target.value)} rows={4} className="w-full resize-y rounded border border-edge bg-panel-2 px-2 py-1.5 text-[11px] text-ink outline-none focus:border-torque" />
            <p className="text-[10px] text-faint">{facts.length} / 20 facts. Each line is checked locally for 1–16,384 UTF-8 bytes; gateway validation remains authoritative.</p>
            <button type="button" onClick={submitFacts} disabled={!validFacts(facts)} className="rounded border border-torque/40 px-2 py-1 text-[10.5px] text-torque hover:bg-torque/10 disabled:opacity-50">Record facts</button>
          </div>}
          {detail.execution.facts.length === 0 ? <p className="mt-2 text-[10.5px] text-faint">No immutable fact metadata is available yet.</p> : (
            <fieldset className="mt-3 space-y-1">
              <legend className="text-[10.5px] text-muted">Select immutable facts for one local attempt</legend>
              {detail.execution.facts.map((fact) => <label key={fact.factId} className="flex items-start gap-2 text-[10.5px] text-muted"><input type="checkbox" checked={selectedFactIds.includes(fact.factId)} onChange={() => toggleFact(fact.factId)} disabled={!detail.execution.capabilities.canStart} /><span>Fact {fact.ordinal} — sha256 {fact.sha256.slice(0, 12)}...</span></label>)}
              <button type="button" onClick={() => actions.onStart(selectedFactIds)} disabled={!canStart} className="mt-2 rounded border border-torque/40 px-2 py-1 text-[10.5px] text-torque hover:bg-torque/10 disabled:opacity-50">Start local draft and configured review</button>
            </fieldset>
          )}
        </div>
      )}

      <div className="mt-4 border-t border-edge pt-3">
        <p className="text-[9px] font-bold uppercase tracking-[0.1em] text-faint">Validated output</p>
        {readableArtifacts.length === 0 ? <p className="mt-2 text-[10.5px] text-faint">No validated proposal or configured review is recorded.</p> : (
          <ul className="mt-2 space-y-1">{readableArtifacts.map((item) => <li key={item.artifactId}><button type="button" onClick={() => actions.onReadArtifact(item.artifactId)} className="text-left text-[10.5px] text-torque underline decoration-edge underline-offset-4 hover:text-ink">Open {item.artifactType === 'proposal' ? 'validated proposal' : 'configured review'} revision {item.revision}</button></li>)}</ul>
        )}
        {artifactStatus === 'loading' && <p className="mt-2 text-[10px] text-faint" role="status">Loading validated output...</p>}
        {artifactStatus !== 'idle' && artifactStatus !== 'loading' && <p className="mt-2 text-[10px] text-faint" role="status">Validated output is unavailable. Refresh execution from the gateway.</p>}
        {artifact !== null && verified === null && artifactStatus === 'idle' && <p className="mt-2 text-[10px] text-faint" role="status">Validated output could not be verified and is not shown.</p>}
        {verified !== null && <div className="mt-3 space-y-2"><pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded border border-edge bg-panel-2 p-2 text-[10.5px] text-ink">{verified.content}</pre><div className="flex flex-wrap gap-2"><button type="button" onClick={copyArtifact} className="rounded border border-edge px-2 py-1 text-[10.5px] text-muted hover:text-ink">Copy locally</button><button type="button" onClick={downloadArtifact} className="rounded border border-edge px-2 py-1 text-[10.5px] text-muted hover:text-ink">Download local JSON</button></div>{copyStatus === 'copied' && <p className="text-[10px] text-faint" role="status">Copied locally.</p>}{copyStatus === 'failed' && <p className="text-[10px] text-faint" role="status">Copy was not completed.</p>}{downloadStatus === 'downloaded' && <p className="text-[10px] text-faint" role="status">Local download started.</p>}{downloadStatus === 'failed' && <p className="text-[10px] text-faint" role="status">Local download was not completed.</p>}</div>}
      </div>
    </section>
  );
}
