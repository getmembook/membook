#!/usr/bin/env bash
# Run AFTER flipping getmembook/membook to public.
# Branch protection, private vulnerability reporting and secret scanning are
# all public-only on this plan, which is why none of it could be pre-staged.
set -euo pipefail

REPO=getmembook/membook

echo "==> Branch protection on main"
# A REQUIRED CHECK THAT NEVER RUNS BLOCKS EVERY PR FOREVER.
#
# Only jobs that actually run on pull requests may be listed here. macOS was
# in this list and has been removed: it now runs on merges to main only, to
# escape the 10x private-repo minute multiplier. Requiring it would have made
# every pull request unmergeable, waiting on a check that is never reported.
#
# The repo is public, so Actions are free and macOS is back on pull requests
# in ci.yml — and therefore back in this list.
#
# Windows is deliberately NOT required: it is advisory and currently fails,
# because better-sqlite3 has no prebuilt for recent Node on Windows.
# `packaged install` IS required — it caught a tarball shipping `workspace:*`,
# which meant the published binary never linked.
#
# enforce_admins=false so you can still hotfix; these guards are about
# preventing accidents, not ceremony.
gh api -X PUT "repos/$REPO/branches/main/protection" \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "test (ubuntu-latest, node 20)",
      "test (ubuntu-latest, node 24)",
      "test (macos-latest, node 20)",
      "test (macos-latest, node 24)",
      "packaged install"
    ]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true,
  "required_linear_history": true
}
JSON

echo "==> Require signed commits on main"
# PREREQUISITE: the signing key must be registered on GitHub as a SIGNING key,
# which is a different list from authentication keys. Without it, git verifies
# your commits locally while GitHub reports `unknown_key`, and everything you
# push shows as Unverified.
#
#   gh auth refresh -h github.com -s admin:ssh_signing_key
#   gh ssh-key add ~/.ssh/id_ed25519.pub --type signing --title "commit signing"
#
# Dependabot is unaffected: GitHub signs the commits it authors, and they
# already verify. A squash merge is likewise signed by GitHub, so the practical
# effect is to close the direct-push path onto main — which is the point.
gh api -X POST "repos/$REPO/branches/main/protection/required_signatures" >/dev/null
gh api "repos/$REPO/branches/main/protection/required_signatures" \
  --jq '"    required_signatures: \(.enabled)"'

echo "==> Private vulnerability reporting (SECURITY.md links to this)"
gh api -X PUT "repos/$REPO/private-vulnerability-reporting"

echo "==> Secret scanning and push protection"
gh api -X PATCH "repos/$REPO" --input - <<'JSON'
{
  "security_and_analysis": {
    "secret_scanning": { "status": "enabled" },
    "secret_scanning_push_protection": { "status": "enabled" }
  }
}
JSON

echo
echo "==> Verify"
gh api "repos/$REPO/branches/main/protection" \
  --jq '{force_push:.allow_force_pushes.enabled, deletions:.allow_deletions.enabled, linear:.required_linear_history.enabled, signed:.required_signatures.enabled, checks:.required_status_checks.contexts}'
gh api "repos/$REPO" \
  --jq '{secret_scanning:.security_and_analysis.secret_scanning.status, push_protection:.security_and_analysis.secret_scanning_push_protection.status}'

echo
echo "Done. If you later want to require pull requests as well:"
echo '  gh api -X PATCH "repos/'"$REPO"'/branches/main/protection/required_pull_request_reviews" -F required_approving_review_count=0'
