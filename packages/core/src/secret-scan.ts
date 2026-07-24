import type { WriteGuard, WriteCandidate } from "./guard.js";
import type { WriteGuardFinding } from "./errors.js";

/**
 * THE SECRET SCANNER. DENY-BIASED BY DESIGN.
 *
 * The asymmetry is total and decides every judgement call here:
 *
 *   false positive → a memory is blocked, a human looks at it, done.
 *   false negative → a credential is committed, pushed, and cloned. Forever.
 *
 * So when a rule is torn, it blocks. Being occasionally annoying is a price
 * worth paying; being occasionally catastrophic is not. A blocked write says
 * exactly which rule fired so the author can fix or rephrase it.
 *
 * This runs on the write path before anything reaches `.membook/`, because a
 * secret that reaches disk in a repository is already most of the way to
 * being published.
 */

export interface SecretRule {
  id: string;
  description: string;
  pattern: RegExp;
  /** Extra check to suppress the obvious documentation case. */
  refine?: (match: string) => boolean;
}

/** Shannon entropy in bits per character. */
export function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * A value that looks placeholder-ish rather than real.
 *
 * This is the ONLY suppression in the scanner, and it is deliberately narrow:
 * it catches the documentation case (`token = "<your-token-here>"`) without
 * giving a real credential anywhere to hide.
 */
function looksLikePlaceholder(value: string): boolean {
  const v = value.toLowerCase();
  return (
    /^[x*.]+$/.test(value) ||
    /^<.*>$/.test(value) ||
    /\{\{.*\}\}/.test(value) ||
    /\$\{.*\}/.test(value) ||
    v.includes("example") ||
    v.includes("placeholder") ||
    v.includes("your-") ||
    v.includes("your_") ||
    v.includes("redacted") ||
    v.includes("changeme") ||
    v.includes("dummy") ||
    v.includes("fake") ||
    /^(foo|bar|baz|test|sample|secret|password|token)$/.test(v)
  );
}

/**
 * High-precision provider patterns. These are shaped credentials — matching
 * one is essentially never a coincidence, so none of them are refined away.
 */
export const SECRET_RULES: SecretRule[] = [
  {
    id: "aws-access-key",
    description: "AWS access key id",
    pattern: /\b((?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16})\b/g,
  },
  {
    id: "github-token",
    description: "GitHub token",
    pattern: /\b((?:ghp|gho|ghu|ghs|ghr|github_pat)_[0-9A-Za-z_]{20,})\b/g,
  },
  {
    id: "slack-token",
    description: "Slack token",
    pattern: /\b(xox[baprs]-[0-9A-Za-z-]{10,})\b/g,
  },
  {
    id: "stripe-key",
    description: "Stripe secret key",
    pattern: /\b((?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,})\b/g,
  },
  {
    id: "google-api-key",
    description: "Google API key",
    pattern: /\b(AIza[0-9A-Za-z_-]{35})\b/g,
  },
  {
    id: "openai-key",
    description: "OpenAI API key",
    pattern: /\b(sk-(?:proj-)?[0-9A-Za-z_-]{20,})\b/g,
  },
  {
    id: "anthropic-key",
    description: "Anthropic API key",
    pattern: /\b(sk-ant-[0-9A-Za-z_-]{20,})\b/g,
  },
  {
    id: "npm-token",
    description: "npm access token",
    pattern: /\b(npm_[0-9A-Za-z]{36})\b/g,
  },
  {
    id: "private-key",
    description: "Private key block",
    pattern: /(-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----)/g,
  },
  {
    id: "jwt",
    description: "JSON Web Token",
    pattern:
      /\b(eyJ[0-9A-Za-z_-]{10,}\.eyJ[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,})\b/g,
  },
  {
    id: "connection-string-password",
    description: "Connection string with an inline password",
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s/@]{3,})@[^\s/]+)/gi,
    refine: (match) => {
      const password = /:\/\/[^\s:/@]+:([^\s/@]{3,})@/.exec(match)?.[1] ?? "";
      return !looksLikePlaceholder(password);
    },
  },
  {
    id: "assigned-secret",
    description: "Secret-looking value assigned to a secret-looking name",
    // `api_key = "..."`, `password: '...'`, `SECRET_TOKEN=...`
    pattern:
      /\b((?:api[_-]?key|secret|passwd|password|token|credential|auth)[a-z0-9_-]*)\s*[:=]\s*["']?([^\s"'`,;]{8,})["']?/gi,
    refine: (match) => {
      const value = /[:=]\s*["']?([^\s"'`,;]{8,})["']?/.exec(match)?.[1] ?? "";
      if (looksLikePlaceholder(value)) return false;
      // A real credential is dense. Prose assigned to `password:` is not, and
      // this is the one rule where prose could plausibly trip the pattern.
      return entropy(value) >= 3 || /[0-9]/.test(value);
    },
  },
];

export interface SecretScanOptions {
  rules?: readonly SecretRule[];
}

/** Scan text and report every rule that fires. */
export function scanForSecrets(
  text: string,
  options: SecretScanOptions = {}
): WriteGuardFinding[] {
  const rules = options.rules ?? SECRET_RULES;
  const findings: WriteGuardFinding[] = [];

  for (const rule of rules) {
    // Patterns are global; reset so a previous scan cannot skip a match.
    rule.pattern.lastIndex = 0;
    for (const match of text.matchAll(rule.pattern)) {
      const hit = match[0];
      if (rule.refine && !rule.refine(hit)) continue;
      findings.push({
        rule: rule.id,
        message: `${rule.description} detected — ${redact(hit)}`,
      });
      break; // One finding per rule is enough to block; do not leak more.
    }
  }

  return findings;
}

/**
 * Show enough to locate the secret, never enough to use it.
 *
 * The error message travels into logs, terminals, and CI output, so echoing
 * the credential back would defeat the point of catching it.
 */
export function redact(value: string): string {
  const visible = value.slice(0, 4);
  return `${visible}${"*".repeat(Math.max(4, Math.min(12, value.length - 4)))}`;
}

/**
 * The launch-blocking guard. Drops into the seam built in step 2 with no
 * changes to any call site.
 */
export class SecretScanGuard implements WriteGuard {
  readonly name = "secret-scan";
  private readonly rules: readonly SecretRule[];

  constructor(options: SecretScanOptions = {}) {
    this.rules = options.rules ?? SECRET_RULES;
  }

  inspect(candidate: WriteCandidate): WriteGuardFinding[] {
    // Scan the FULL serialized text, not just the body: frontmatter carries
    // provenance and anchor paths, and a secret pasted into any of them is
    // committed exactly the same way.
    return scanForSecrets(candidate.text, { rules: this.rules });
  }
}
