// Core modules
export { runCollaborationMigration } from './migration.js';
export { DeterministicClock, DeterministicUuids } from './harness.js';

// Validators
export { normalizeMessageText, normalizeName } from './text.js';
export { parseFrame, isCanonicalUuid, type FrameValidationError } from './frame.js';

// Case folding
export { assertFoldTableVersion, nameKey } from './fold.js';

// Canonical JSON
export { canonicalJson } from './canonical.js';

// Secrets
export {
  type SecretStore,
  InMemorySecretStore,
  WindowsCredentialManagerStore,
  NotImplementedError,
} from './secrets.js';

// Bootstrap and recovery
export {
  type Clock,
  type UuidSource,
  type RandomSource,
  type BootstrapDb,
  type BootstrapEnv,
  type BootstrapResult,
  type RecoveryKit,
  type KitFormatVersion1,
  type KitFormatVersion2,
  type RecoveryKitPayload,
  type RecoveryKitVerifyResult,
  nodeRandomSource,
  systemClock,
  BootstrapRefusedError,
  RecoveryKitError,
  assertPersistentSecretStore,
  exportRecoveryKit,
  verifyRecoveryKit,
  recoveryKitChecksum,
  principalPepperCheck,
  recoveryPepperCheck,
  verifyPepperCheck,
  bootstrapOperator,
} from './bootstrap.js';

// Credentials
export {
  issueCredential,
  verifyCredential,
  hmacSha256,
  credentialHmacOperationCount,
  resetCredentialHmacOperationCount,
  type IssuedCredential,
  type CredentialLookup,
  type VerifyCredentialResult,
} from './credentials.js';

// Rate limiting
export {
  AuthRateLimiter,
  normalizeCredentialId,
  normalizeAddress,
  isLoopbackAddress,
  systemRateLimitClock,
  type RateLimitClock,
  type AuthAttemptOutcome,
  type CheckResult,
} from './ratelimit.js';

// Collaboration store (identity + channel layer)
export {
  CollaborationStore,
  Mutex,
  CollabError,
  CredentialHmacCollisionError,
  credentialLookupFromDb,
  type CollabErrorCode,
  type CollaborationStoreEnv,
  type CallerContext,
  type CredentialProducingResult,
  type RotateCredentialResult,
  type AgentLifecycleResult,
  type RevokeAgentResult,
  type RevokeCredentialResult,
  type CreateChannelResult,
  type ChannelMemberResult,
  type ChannelArchiveResult,
  type TimelineEventObject,
  type ListChannelsEntry,
  type ListChannelsResult,
  type GetChannelTimelineResult,
  type AckChannelCursorResult,
  type PostChannelMessageResult,
  type SubscribeChannelResult,
  type UnsubscribeChannelResult,
} from './store.js';

// Live slice: authorization RW-lock (Section 8.3, G1R C2)
export { AuthLock, AuthLockUpgradeError } from './authlock.js';

// Live slice: in-memory subscription registry (Sections 5.5, 8.1-8.3)
export {
  Subscription,
  SubscriptionRegistry,
  SUBSCRIPTION_CLOSE_REASONS,
  type SubscriptionCloseReason,
  type SubscriptionState,
  type ChannelEventFrame,
  type SubscriptionCloseFrame,
  type DeliveryFrame,
  type QueuedFrame,
  type DeliverySink,
  type EpochSnapshot,
  type SubscriptionParams,
} from './subscriptions.js';

// Live slice: per-write revalidation + fan-out (Sections 8.2, 8.3, G1R C1/H1/H4)
export {
  fanoutOne,
  fanoutToChannel,
  readRevalidationSnapshot,
  revalidationPasses,
  type CommittedChannelEvent,
  type FanoutDeps,
  type RevalidationRowsSnapshot,
} from './fanout.js';

// Live slice: authorization coordinator (Section 8.2, G1R C2/C4)
export {
  runAuthorizationMutation,
  affectedByChannel,
  affectedByPrincipal,
  affectedBySession,
  type CoordinatorDeps,
  type AffectedSet,
} from './coordinator.js';

// Live slice: slow-consumer detection (Section 7.7, G1R H3)
export {
  checkSlowConsumer,
  checkAndCloseSlowConsumer,
  tickSlowConsumers,
  SLOW_CONSUMER_BYTE_LIMIT,
  SLOW_CONSUMER_AGE_MS,
  type SlowConsumerCheckResult,
} from './slowconsumer.js';

// Live slice: observability counters (Section 13)
export {
  CollabObservability,
  type ConnectOutcome,
  type AuthorizationDenialClass,
} from './observability.js';

// Sessions
export {
  SESSION_CLOSE_REASONS,
  type SessionCloseReason,
  type SessionBindingRow,
  type CreateSessionParams,
  createSessionBinding,
  closeSessionBinding,
  getSessionBinding,
  type RegisteredSession,
  SessionRegistry,
  type BaseEvaluationResult,
  evaluateBase,
  type GatewayMode,
  type StartupResult,
  performStartup,
} from './sessions.js';

// Headless doctor (Section 13, G1R L1)
export {
  doctor,
  COLLABORATION_MIGRATION_ID,
  type DoctorResult,
  type DoctorPeppers,
} from './doctor.js';

// Rollback / rollout (Section 11, G1R C1/C2/H1/M2/M3)
export {
  performNormalRollback,
  performDestructiveRestore,
  checksumRowSet,
  checksumBytes,
  checksumLiveDb,
  RESTORE_CONFIRMATION_STRING,
  type CollabFeatureFlags,
  type GatewayLivenessProbe,
  type BackupRecord,
  type BackupTaker,
  type PreMigrationManifest,
  type ReceiptSink,
  type RestoreIntentReceipt,
  type RestoreCompletionReceipt,
  type RestoreBoundary,
  type RollbackEnv,
  type NormalRollbackFixtureRowSet,
  type NormalRollbackResult,
  type DestructiveRestorePreconditionFailure,
  type DestructiveRestoreInput,
  type DestructiveRestoreDeps,
  type DestructiveRestoreResult,
} from './rollback.js';

// Benchmark (Section 15, G1R H2/H3/H4/L3)
export {
  nearestRankPercentile,
  assertObservationFloors,
  BenchmarkFloorError,
  measureRevocationWindow,
  assertExactlyTwoNowMsCalls,
  NowMsCallCountError,
  checkSequenceIntegrity,
  checkNoPostLinearizationWrites,
  buildRevocationPlan,
  countRevocationKinds,
  buildBenchmarkReportArtifact,
  TIMELINE_OBSERVATION_FLOOR,
  COMMIT_OBSERVATION_FLOOR,
  FANOUT_OBSERVATION_FLOOR,
  REVOCATION_OBSERVATION_FLOOR,
  REVOCATION_SUSPEND_RESTORE_PAIR_FLOOR,
  REVOCATION_ARCHIVE_UNARCHIVE_PAIR_FLOOR,
  REVOCATION_REVOKE_AGENT_EXACT_COUNT,
  REPORT_THRESHOLDS_MS,
  REFERENCE_NODE_VERSION,
  type RevocationWindowMeasurement,
  type SequenceIntegrityResult,
  type PostLinearizationWriteCheck,
  type RevocationMutationKind,
  type RevocationPlanEntry,
  type BenchmarkReportArtifact,
} from './benchmark.js';

// Note: the no-await guard mechanism (noawaitguard.ts, G1R H6) is a TEST/DEV
// tool, not a production export. It imports `typescript` at load time; if
// it were re-exported here, that pulls `typescript` into this package's
// production runtime import closure. It is imported directly by
// tests/collab/noawaitguard.test.ts instead, keeping `typescript` a
// devDependency (see package.json).
