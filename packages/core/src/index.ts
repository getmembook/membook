export { Membook, type MembookOptions, type StatusReport } from "./membook.js";
export {
  MemoryStore,
  type StoredMemory,
  type ReadAllResult,
  type MemoryStoreOptions,
} from "./store.js";
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
  type WriteBlockedEvent,
  type BookEvent,
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
  type LlmRecheckerOptions,
} from "./llm-recheck.js";
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
  isGitRepository,
  headSha,
  commitExists,
  changesSince,
  followRename,
  pathExistsAt,
  showFile,
  GitError,
  NotAGitRepositoryError,
  type ChangeKind,
  type PathChange,
} from "./git.js";
