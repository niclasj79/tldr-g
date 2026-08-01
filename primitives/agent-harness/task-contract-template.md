<!--
TASK CONTRACT TEMPLATE
======================
Copy this file, replace every {{PLACEHOLDER}}, delete the guidance comments.

This is what you hand a coding agent instead of a prompt. It is written to be
read cold — by an agent with no conversation history, and by a human finishing
the work days later. If a section only makes sense to whoever was in the
session, it is not filled in yet.

Fill in the Finalize Runbook BEFORE firing. Agents hit rate limits and context
ceilings mid-task; somebody has to finish, and it may not be you.
-->

# Task Contract — {{TASK NAME}}

**ID:** `{{TRACKING-ID}}`
**Status:** 🟠 NOT STARTED   <!-- → 🟡 IN FLIGHT → ✅ CLOSED YYYY-MM-DD -->
**Authored:** {{YYYY-MM-DD}}
**Source of truth:** {{link to the design doc / issue / spec this implements, + section}}

**Why now:** {{one line — what this unblocks, or which commitment it serves. If nothing, say so and justify building it anyway.}}

**Composes with (already shipped):**
- {{existing module / endpoint / table this builds on — the things it must NOT reinvent}}

**Agent:** {{which agent/model}} · branch `{{branch-name}}` · isolated working copy at `{{path}}`
<!-- Isolation matters if anything else touches the repo concurrently. One writer
     per working copy; a second actor gets its own checkout. -->

**Reviewer:** {{who/what reviews it, and FOR WHAT — name the focus. "Review the PR" is not a focus.}}

**Human role:** {{the smoke check a person performs at the end, concretely}}

**Budget:** ~{{N}} agent-hours/days ({{M}} items). **Spend ceiling: ${{0 or amount}}** {{if the task makes priced calls, state the per-call profile and apply the cost gate}}

---

## Acceptance condition

<!-- THE LOAD-BEARING SECTION.

     Every clause must be DEMONSTRABLE FROM THE AGENT'S OWN OUTPUT — not merely
     true. "Faster" is unverifiable from a transcript. "p50 under 200ms, shown by
     the benchmark output in the run log" is verifiable.

     If you cannot phrase a clause demonstrably, you have not specified it yet.
     Move it to Human Review below and label it honestly.

     Always include a turn cap. An agent without one will grind. -->

```
{{TASK NAME}} is complete when:

(1) {{demonstrable clause — a file exists and behaves, a test passes, an endpoint
    returns a named field, a command exits 0}}

(2) {{demonstrable clause}}

(3) {{...}}

(N) The work is merged and the branch is closed: `git cherry {{main}} {{branch-name}}`
    returns no `+`-prefixed lines.

Stop after {{N}} turns.
```

**Explicitly NOT in scope:** {{the adjacent things a capable agent will be tempted to also fix. Naming them is cheaper than reviewing them.}}

---

## Items

<!-- One item per atomic commit. If an item would touch more than ~10 files, split
     it: code+tests first, then docs+bookkeeping. -->

### Item 1 — {{title}}

**Output:** {{files created or modified}}

**Spec:**
- {{concrete step}}

**Acceptance:** {{how this item specifically is verified}}

**Commit:** `{{type}}: {{what changed — and why}}`

### Item N — Tests, docs, close

**Commit:** `{{slug}}: end-to-end test + close`

---

## Operator surface

<!-- Fill this in for anything that ships a capability. We added this section after
     shipping a feature that was fully tested, fully merged, and completely
     unreachable — no endpoint, no command, no way to run it on real data. It sat
     that way for six days. Asked at contract-writing time, the answer is one line;
     discovered later, it is a second task.

     If the work genuinely has no operator surface (internal refactor, test
     infrastructure), say why in two sentences and skip the checkboxes. The point is
     to prevent the gap, not to add ceremony. -->

**How does a human trigger this?**

- [ ] HTTP endpoint: {{exact method + path, or N/A + reason}}
- [ ] CLI command: {{exact command + arguments, or N/A + reason}}
- [ ] Agent/tool surface: {{exact tool name, or N/A + reason}}
- [ ] Automatic: {{fires on startup / ingest / schedule / other, or N/A + reason}}

**How do they confirm it fired?**

- [ ] Diagnostics output: {{endpoint or command returning structured state, or N/A}}
- [ ] Health field: {{the specific field name, or N/A}}
- [ ] Log marker: {{the exact prefix to grep for, or N/A}}
- [ ] Metric/counter: {{what to watch, or N/A}}

**One-line smoke check:**
```
{{the literal command a human runs, and what a pass looks like}}
```

---

## New parameters

<!-- A new flag, env var, or request field must be proven to bind THROUGH the
     surface that exposes it — an actual request, not an internal call.

     We shipped a feature whose tests were 9/9 green while its headline HTTP
     parameter never bound to anything. The tests exercised the internals
     directly, so the parameter was never sent, and nothing noticed. -->

| Parameter | Surface | Proof it binds |
|---|---|---|
| {{name}} | {{HTTP / CLI / tool}} | {{the test that sends it through the real surface and observes a behavioural difference}} |

---

## Human review

<!-- The clauses that could NOT be made agent-demonstrable. Being honest here is the
     whole reason the acceptance condition above stays trustworthy — every item you
     fudge into it costs you the ability to believe any of it. -->

- [ ] {{judgement call requiring a person, and what specifically they are judging}}

---

## Finalize runbook

<!-- WRITE THIS BEFORE FIRING. Usable cold, with concrete values, by someone who was
     not in the session. This is the section that gets skipped and then needed. -->

If the agent stops before completing:

1. **State:** branch `{{branch-name}}`, working copy `{{path}}`.
2. **Check what landed:** `git log --oneline {{main}}..{{branch-name}}`
3. **Run the tests:** `{{literal command}}`
4. **Remaining items:** see Items above; each is independently committable.
5. **To close:** `{{literal merge command}}`, then set Status ✅ above.
6. **To abandon:** {{how to unwind — branch deletion, working-copy removal, anything to revert}}

---

## Notes

{{Anything the agent should know that is not a requirement: a gotcha in the area,
a prior attempt that failed and why, a file that looks relevant but is not.}}
