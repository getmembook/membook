---
"@membook/core": patch
---

`openIndex` closes the database handle on every throw path. The
metadata-mismatch throws leaked it, which was invisible on POSIX but made the
index undeletable on Windows — so `membook reindex`, whose remedy for drift is
deleting the file, failed with EBUSY. The error path no longer blocks its own
cure.
