# Publication Checklist

This repo is not public-ready until every required row is checked.

## Required

- [ ] Founder confirms final OSI license (`MIT` in this candidate; Apache-2.0 still may be preferable if IP-grant posture matters).
- [ ] README claims scrubbed against the launch proof pack.
- [x] Clean virtualenv install smoke passes on Windows. See `docs/smoke-2026-06-11.md`.
- [x] `python examples/quickstart.py` passes after install.
- [x] Public smoke tests pass.
- [x] Secret/internal-term scan passes.
- [ ] Source boundary review resolves the full-package inclusion question in `PUBLIC_BOUNDARY.md`.
- [ ] Windows installer points at this repo/package and passes clean-machine smoke.
- [ ] At least three outside soft-seed installs complete or launch slips by the ratified rule.

## Explicitly Not Required For Launch

- FRAMES rerun.
- sovereign GPU run.
- Public M2.1 head-to-head.
- Continent-rung multi-membership.
- World-map render.
