/**
 * Credential-shaped test fixtures, assembled at RUNTIME from fragments.
 *
 * Testing a secret scanner requires strings shaped exactly like credentials,
 * and writing those as literals puts credential-shaped text into git — where
 * this repository's own pre-commit gitleaks hook correctly blocks it.
 *
 * The fix is deliberately NOT an allowlist. An allowlist entry is the exact
 * mechanism someone later copies to silence a real finding, and a project
 * whose thesis is "secrets never reach committed files" should not ship a
 * worked example of annotating your way past a scanner. Assembled from
 * fragments, no fragment matches any rule on its own, so the repository
 * contains no credential-shaped string at all — every scanner stays quiet
 * honestly rather than by exception.
 *
 * None of these are real. They are shaped like the real thing and nothing more.
 */
export const FAKE_SECRETS = {
  awsKey: ["AKIA", "IOSFODNN7EXAMPLQ"].join(""),
  githubToken: ["ghp_016C6bD8fA2eB1c9", "D4e7F0a3B6c9D2e5F8a1B4c7"].join(""),
  slackToken: ["xoxb", "1234567890-abcdefghijklmnop"].join("-"),
  stripeKey: ["sk", "live", "51H8xKlAbCdEfGhIjKlMnOpQr"].join("_"),
  googleKey: ["AIza", "SyC1sTgHkLmNoPqRsTuVwXyZ01234567890"].join(""),
  openAiKey: ["sk", "proj", "abc123XYZ", "789def456GHI012"].join("-"),
  anthropicKey: ["sk", "ant", "api03", "abc123XYZ", "789def456GHI012"].join(
    "-"
  ),
  npmToken: ["npm", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join("_"),
  privateKeyHeader: ["-----BEGIN RSA ", "PRIVATE KEY-----"].join(""),
  jwt: [
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
    "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  ].join("."),
  dbPassword: ["h7Kp", "2xQm9Lz"].join(""),
  assignedValue: ["9fKq2mZx", "7Lp4Rv8Tn3Wb"].join(""),
} as const;
