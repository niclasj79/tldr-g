# Publication Checklist

In-repo mirror of the project's **external-share gate** (the project's internal
tracker holds the authoritative copy + live status).

**This repo MUST NOT be shared externally — even selectively to one trusted
person — until every G-row below is green.** A private pre-share is still
publication.

## Gate (G1–G7)

- [x] **G1 — Scope ratified.** ✅ RATIFIED 2026-06-11. Ships contracts + offline verification, NOT the engine. `public/allowlist.txt` + `PUBLIC_BOUNDARY.md` reflect it.
- [x] **G2 — Automated scrub clean.** ✅ `python tools/sync_public_repo.py` exits 0 on the narrowed surface (validated 2026-06-11).
- [x] **G3 — Manual scrub.** ✅ 2026-06-11. Clean overlay contract docs (internal "PRIVATE DRAFT/patent-counsel" home notes not synced); sync-process meta gitignored from the shared repo; README de-internalized; `tp-vrg-verify` CLI added so the verify docs are real. README is category-first; no patent framing, retracted claims, or PII on the shipped surface.
- [x] **G4 — License ratified + present.** ✅ Apache-2.0 (ratified 2026-06-11); `LICENSE` + `pyproject.toml` match.
- [ ] **G5 — Install + smoke green on THIS scoped repo.** Validated here via source path (`import tp_vrg` engine-free + `quickstart.py` + 31 tests pass 2026-06-11); founder runs the final `pip install -e .` on a clean venv to confirm.
- [x] **G6 — Claims grounded.** ✅ The narrowed surface carries no quantitative performance claims (format specs + verification) — nothing to ground.
- [x] **G7 — Verify story works.** ✅ `tp-vrg-verify` returns VALID on a signed export; sign→verify→tamper demonstrated by `quickstart.py` + `test_attestation`.

## Explicitly Not Required For Launch

- FRAMES rerun · sovereign GPU run · public M2.1 head-to-head · continent-rung multi-membership · world-map render.
