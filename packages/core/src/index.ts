export { Membook, type MembookOptions, type StatusReport } from "./membook.js";
export { MemoryStore, type StoredMemory, type ReadAllResult, type MemoryStoreOptions } from "./store.js";
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
export { search, toMatchQuery, type SearchHit, type SearchOptions } from "./search.js";
