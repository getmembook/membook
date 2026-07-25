---
"@membook/core": patch
---

New `rememberMany` on `Membook`: batch writes open the index once instead of
per memory. Seeding and other bulk paths are dramatically faster on platforms
where database open/close is expensive (Windows most of all). Additive API;
shipped as a patch because this project reserves 0.2 for the workspace
roadmap and the pre-1.0 minor lane signals breakage.
