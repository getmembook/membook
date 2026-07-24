import type { ZodError } from "zod";

/**
 * Raised whenever a Memfile fails validation — on read or on write.
 * Malformed memories must fail loudly; callers (core) quarantine, never skip.
 */
export class MemfileValidationError extends Error {
  readonly issues: string[];
  readonly file: string | undefined;

  constructor(issues: string[], file?: string) {
    const where = file ? ` in ${file}` : "";
    super(
      `Invalid Memfile${where}:\n${issues.map((i) => `  - ${i}`).join("\n")}`,
    );
    this.name = "MemfileValidationError";
    this.issues = issues;
    this.file = file;
  }

  static fromZodError(error: ZodError, file?: string): MemfileValidationError {
    const issues = error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    });
    return new MemfileValidationError(issues, file);
  }
}
