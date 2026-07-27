export { Membook, type MembookOptions, type StatusReport } from "./membook.js";
export {
  MemoryStore,
  type AnchoredMemfile,
  type StoredMemory,
  type ReadAllResult,
  type MemoryStoreOptions,
} from "./store.js";
export {
  UserStore,
  userPaths,
  type UserPaths,
  type UserMemfile,
  type StoredUserMemory,
  type UserReadResult,
  type UserRememberInput,
  type UserStoreOptions,
} from "./user-store.js";
export { repoPaths, type RepoPaths } from "./paths.js";
export {
  NoopWriteGuard,
  runGuards,
  type WriteGuard,
  type WriteCandidate,
} from "./guard.js";
export {
  IndexMetadataMismatchError,
  MemoryNotFoundError,
  WriteBlockedError,
  type QuarantineRecord,
  type WriteGuardFinding,
} from "./errors.js";
export {
  INDEX_METADATA,
  openIndex,
  readMetadata,
  writeMetadata,
  assertMetadataMatches,
  type IndexDb,
  type IndexMetadata,
} from "./index-db.js";
export {
  reindex,
  indexMemory,
  removeFromIndex,
  type ReindexResult,
} from "./reindex.js";
export {
  search,
  toMatchQuery,
  type SearchHit,
  type SearchOptions,
} from "./search.js";
export {
  FileInstrumentation,
  NullInstrumentation,
  type Instrumentation,
  type MembookEvent,
  type RecallEvent,
  type RememberEvent,
  type VerifyEvent,
  type RecheckEvent,
  type ReviewEvent,
  type DistillEvent,
  type WriteBlockedEvent,
  type BookEvent,
  type MigrateEvent,
} from "./instrumentation.js";
export { FAKE_SECRETS } from "./fake-secrets.js";
export {
  SecretScanGuard,
  scanForSecrets,
  entropy,
  redact,
  SECRET_RULES,
  type SecretRule,
  type SecretScanOptions,
} from "./secret-scan.js";
export {
  AnthropicProvider,
  OpenAiCompatibleProvider,
  ProviderError,
  type ModelProvider,
  type CompletionRequest,
  type CompletionResult,
} from "./provider.js";
export {
  LlmRechecker,
  VERDICTS,
  quoteAppearsIn,
  type LlmRecheckerOptions,
} from "./llm-recheck.js";
export {
  distill,
  sourceHash,
  DISTILL_SYSTEM,
  MAX_STATEMENT_CHARS,
  DEFAULT_MAX_PER_SOURCE,
  type DistillCandidate,
  type DistillRejection,
  type DistillResult,
  type DistillSource,
  type DistillOptions,
  type RejectionReason,
} from "./distill.js";
export {
  seed,
  seedFrontmatter,
  findSeedSources,
  SEED_SYSTEM,
  MIN_SOURCE_CHARS,
  MAX_SOURCE_CHARS,
  DEFAULT_MAX_FILES,
  type SeedCandidate,
  type SeedReport,
  type SeedOptions,
  type SeedSourceFile,
} from "./seed.js";
export {
  migrateStore,
  type MigrateEntry,
  type MigrateOptions,
  type MigrateReport,
} from "./migrate.js";
export {
  compileBook,
  writeBook,
  expectedValue,
  estimateTokens,
  BOOK,
  type BookReport,
  type BookEntry,
} from "./book.js";
export {
  recall,
  pathAffinity,
  queryTerms,
  termCoverage,
  matchedTerms,
  evidenceFactor,
  RANKING,
  type RecallOptions,
  type RecallResult,
  type RecallHit,
  type RecallAnchor,
} from "./recall.js";
export {
  verifyPass,
  type VerifyOptions,
  type VerifyReport,
  type MemoryVerdict,
  type AnchorOutcome,
  type AnchorOutcomeKind,
} from "./verify.js";
export {
  ConservativeRechecker,
  type AnchorRechecker,
  type RecheckRequest,
  type RecheckResult,
  type RecheckVerdict,
  type TouchedAnchor,
} from "./recheck.js";
export {
  federatedRecall,
  workspaceCacheDir,
  CROSS_REPO_WEIGHT,
  type FederatedRecallResult,
  type FederatedMemberResult,
  workspaceContext,
  WORKSPACE_CONTEXT_MAX,
  type WorkspaceContextEntry,
  type WorkspaceContextResult,
} from "./federated-recall.js";
export {
  canonicalRemote,
  defaultWorkspacePath,
  resolveWorkspace,
  resolveWorkspaceFile,
  type MemberResolution,
  type ResolvedWorkspace,
  type ResolveOptions,
} from "./workspace.js";
export {
  isGitRepository,
  headSha,
  behindUpstream,
  commitExists,
  originUrl,
  changesSince,
  followRename,
  pathExistsAt,
  findMissingAnchorPaths,
  showFile,
  GitError,
  NotAGitRepositoryError,
  type ChangeKind,
  type PathChange,
} from "./git.js";
