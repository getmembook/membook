import { z } from "zod";
import {
  MEMFILE_SPEC_VERSION,
  memorySchema,
  memoryWireSchema,
  type Memory,
} from "./schema.js";

/**
 * MEMFILE VERSION MACHINERY.
 *
 * `memfile` is a `z.literal`, which is correct and also a trap. Bumping it to
 * 2 does not merely make v1 readers reject v2 files — it makes OUR OWN v2
 * reader reject every existing v1 file, quarantining every memory in every
 * repository the moment someone upgrades. The blast radius of a one-character
 * change is the entire installed base.
 *
 * So the machinery lands before anything forces it in anger. Three rules,
 * and they are the contract external implementers will build against:
 *
 *   1. READ TOLERANCE FOR EVERY VERSION <= CURRENT, FOREVER. A v1 file must
 *      parse under every future package. This is the promise that makes the
 *      format safe to adopt; breaking it once would be unrecoverable, because
 *      the files are the truth and they live in other people's repositories.
 *   2. WRITES ALWAYS EMIT CURRENT. Reading is permissive, writing is not —
 *      the usual asymmetry, for the usual reason.
 *   3. NO SILENT UPGRADE ON TOUCH. Files are committed artifacts, so a
 *      version migration is a reviewable diff, never a side effect of having
 *      opened something. `membook migrate` does it in one explicit commit.
 *
 * Mixed-version stores are therefore legal, indefinitely. `status` reports the
 * spread; nothing forces the issue.
 */

/**
 * A file written by a NEWER Membook than this one.
 *
 * Distinguished from a malformed file on purpose, and it is the difference
 * between two opposite instructions to the user: "this file is broken, repair
 * it" versus "your tool is old, upgrade it". Reporting the second as the first
 * would send someone to hand-edit a file that is perfectly valid, which is how
 * a forward-compatible format acquires a reputation for corrupting data.
 */
export class UnsupportedMemfileVersionError extends Error {
  readonly found: number;
  readonly supported: number;
  readonly file: string | undefined;

  constructor(found: number, file?: string) {
    super(
      `memfile version ${found} was written by a newer Membook (this one reads up to ${MEMFILE_SPEC_VERSION}). ` +
        `Upgrade Membook to read it. The file is not damaged and must not be edited by hand.`
    );
    this.name = "UnsupportedMemfileVersionError";
    this.found = found;
    this.supported = MEMFILE_SPEC_VERSION;
    this.file = file;
  }
}

/**
 * The schema for one memfile version.
 *
 * `wire` is the published, JSON-Schema-exportable form; `file` additionally
 * tolerates a YAML parser handing back a `Date`. Every version carries both,
 * because the wire schema is the standard and the file schema is our reader's
 * concession to `js-yaml`.
 */
/**
 * Typed on `Memory`, not on bare `z.ZodType`.
 *
 * An untyped schema makes `safeParse` return `unknown`, which compiles fine in
 * tests — vitest runs the source — and only fails when tsup emits declarations.
 * Every version must therefore parse to the CURRENT `Memory` shape, which is
 * the real contract anyway: older versions are read by widening them into
 * today's type, never by leaking a second shape into callers.
 */
export interface VersionedMemorySchema {
  readonly version: number;
  readonly file: z.ZodType<Memory>;
  readonly wire: z.ZodType<Memory>;
}

/**
 * Every version this package can read, newest last.
 *
 * Adding a version means adding an entry, never editing one. An existing entry
 * describes files that already exist in the world and cannot be changed by
 * changing our mind — editing one retroactively invalidates memories sitting
 * in repositories we will never see.
 */
export const MEMFILE_SCHEMAS: readonly VersionedMemorySchema[] = [
  { version: 1, file: memorySchema, wire: memoryWireSchema },
];

export const SUPPORTED_MEMFILE_VERSIONS: readonly number[] =
  MEMFILE_SCHEMAS.map((s) => s.version);

/**
 * Read the declared version out of unvalidated frontmatter.
 *
 * Returns null when the field is absent or not a number, which is a malformed
 * file rather than a version problem — the caller reports it through the
 * normal validation path so the message stays about what is actually wrong.
 */
export function readDeclaredVersion(data: unknown): number | null {
  if (typeof data !== "object" || data === null) return null;
  const value = (data as { memfile?: unknown }).memfile;
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/**
 * Pick the schema for a declared version.
 *
 * Throws only for versions ABOVE what this package knows. An unknown version
 * below the current one cannot occur — the registry is append-only — so the
 * remaining case is a file from the future, which is a tooling problem and
 * says so.
 */
export function schemaForVersion(
  version: number,
  file?: string
): VersionedMemorySchema {
  const found = MEMFILE_SCHEMAS.find((s) => s.version === version);
  if (found) return found;
  if (version > MEMFILE_SPEC_VERSION) {
    throw new UnsupportedMemfileVersionError(version, file);
  }
  // A version at or below current that we have no schema for means the
  // registry lost an entry — a packaging error, not user data being wrong.
  throw new Error(
    `no schema registered for memfile version ${version}; this is a Membook packaging bug`
  );
}
