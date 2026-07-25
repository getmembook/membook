---
"membook": patch
---

`membook --version` reads the version from package.json at runtime instead of
a hardcoded string. The published 0.1.1 introduced itself as 0.1.0; changesets
bumps the manifest, and a constant nobody remembers is wrong by the second
release. A test now pins the binary's answer to the manifest.
