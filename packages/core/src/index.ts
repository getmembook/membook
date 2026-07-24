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
