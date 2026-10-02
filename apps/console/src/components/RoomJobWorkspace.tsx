'use client';

import { useMemo, useState } from 'react';
import type { RoomJobDetail, RoomJobListEntry } from './roomJobView';
import { visibleRoomJobDetail } from './roomJobView';

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
}

export interface RoomJobControlsProps {
  connected: boolean;
  stale: boolean;
  canCreate: boolean;
  canCancel: boolean;
  selectedJobId: string | null;
  mutationPending: boolean;
  onCreate: (brief: string) => void;
  onCancel: () => void;
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
  stale, onSelectJob, onRefreshList, onRefreshDetail,
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
                  <p className="text-[10px] text-faint">Preview and download unavailable under this foundation contract.</p>
                </div>
              ) : <p className="mt-2 text-[10.5px] text-faint">Job detail unknown/not loaded.</p>}
      </div>

    </section>
  );
}

export function RoomJobControls({ connected, stale, canCreate, canCancel, selectedJobId, mutationPending, onCreate, onCancel }: RoomJobControlsProps) {
  const [brief, setBrief] = useState('');
  const bytes = byteLength(brief);
  const controlsFresh = connected && !stale;
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
      {selectedJobId && <div className="mt-3"><button type="button" onClick={onCancel} disabled={!canCancelNow} className="rounded border border-bad/40 px-2 py-1 text-[10.5px] text-bad hover:bg-bad/10 disabled:opacity-50">Cancel job</button>{mutationPending && <p className="mt-1 text-[10px] text-faint" role="status">Cancellation request pending confirmation.</p>}</div>}
    </div>
  );
}
