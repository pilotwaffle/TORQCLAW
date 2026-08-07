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

// Collaboration store (identity layer)
export {
  CollaborationStore,
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
} from './store.js';

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
