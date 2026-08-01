# An agent-harness starter kit

The scaffolding a small team uses to delegate real engineering work to coding agents and get back work that can be merged. Extracted from a working setup, generalized, and stripped of anything project-specific.

Four files:

| File | What it is |
|---|---|
| [`task-contract-template.md`](task-contract-template.md) | The contract you hand an agent instead of a prompt |
| [`disciplines/search-before-invent.md`](disciplines/search-before-invent.md) | Fires before any quick fix — look for the solution you already designed |
| [`disciplines/cost-gate.md`](disciplines/cost-gate.md) | Fires before any priced batch call — count, don't estimate |
| [`disciplines/known-technique-check.md`](disciplines/known-technique-check.md) | Fires before hand-rolling an algorithm someone already solved |
| [`disciplines/method-extraction.md`](disciplines/method-extraction.md) | Fires after a notable run — turn what worked into a standing rule |

Nothing here is a framework. There is no runtime, nothing to install, and no dependency on a particular agent product. It is a set of documents and one template, which is the point.

---

## The architecture: two tiers, and a hard budget

The problem every agent harness eventually has is that its own instructions stop fitting. Guidance accretes, every line is individually justified, and the context you meant to spend on the *task* goes to the rules about doing tasks. Ours grew to roughly 16 KB of always-loaded text before anyone measured it.

The fix is a level-of-detail split, and a budget that forces the split to happen:

- **Kernel** — always loaded. The invariant and its check command, nothing else. Some of ours are five lines.
- **Depth** — loaded on match. Worked examples, procedures, incident logs. Each depth document declares when it applies, and the kernel points at it.
- **Archive** — not loaded. History and sweep logs, recoverable from version control when someone actually needs them.

The rule that makes it stick: **new always-on text must displace equivalent existing text, or ship as depth.** "This is individually worth including" is not the bar — if it were, everything would qualify and nothing would ever be removed. The budget is the bar.

The second half is that a depth document's **trigger description is as carefully written as its content**, including the negative cases. A discipline that fires on everything gets ignored on everything. Each file below opens with when it applies and, explicitly, when it does not.

## The contract, and the one idea in it

The template's load-bearing section is the acceptance condition, and the rule governing it is this:

> **Every acceptance clause must be demonstrable from the agent's own output.**

Not "true." *Demonstrable.* "The API is faster" is unverifiable from a transcript. "`GET /health` returns a `security_posture` field, shown by a request in the test output" is checkable by reading what the agent produced. If a clause cannot be checked that way, either it becomes one that can, or it moves to the human-review section — where it is honestly labelled as needing a person.

This one constraint does most of the work. It makes underspecified tasks obvious *before* you fire them, because a clause you cannot phrase demonstrably is a clause you have not thought through.

The rest of the template exists to answer questions the agent will otherwise answer for itself, wrongly:

- **What it composes with** — the already-shipped things it must not reinvent.
- **Who evaluates it, and for what** — a named reviewer with a named focus beats "review the PR."
- **A budget with an explicit ceiling** — including a money ceiling when the task makes priced calls.
- **A mechanical done test** — ours is that the branch is not closed until `git cherry main <branch>` returns nothing. Whether the work is merged is a fact about the repository, not an opinion.
- **An operator surface section** — if the task ships a capability, how does a human trigger it, and how do they confirm it fired? We added this after shipping a feature that was fully tested and completely unreachable: no endpoint, no command, no way to run it on real data for six days. Asked at contract-writing time, the answer costs one line.
- **A finalize runbook** — written *before* firing, usable cold. Agents hit rate limits and context ceilings mid-task. Someone has to finish, possibly days later, without the conversation. If that runbook only makes sense to whoever was in the session, it is not a runbook.

## The four disciplines

They are reactive, not procedural. Each fires on an observation rather than at a step, which is why they are separate documents rather than checklist items.

**Search before invent.** Before any quick fix, threshold bump, or special case: search your own accumulated design notes first. The default failure mode of a capable agent is to generate a fresh solution rather than retrieve the one you already designed and forgot. Watch for the phrasings — *"let me just"*, *"for now"*, *"temporarily"*.

**Cost gate.** Before any batch of priced API calls: read the code path, read the response shape, anchor to a prior measured run, and count the calls with arithmetic. Never estimate by feel. Above a threshold, run three units first and multiply. Ours exists because an "$8–12" estimate hit roughly $60 on a 20-instance slice and was aborted before it reached the ~$900 the full run was heading for — a 15× error on spend, entirely from not reading the code path that decided how many calls happened.

**Known-technique check.** Before hand-rolling a deterministic component — tokenizing, matching, ranking, normalizing — name the established solution and ask whether it is within reach. Usually it is a library you already have installed. Ships with a log of the times the simple version went in first and had to be redone.

**Method extraction.** After a notable run, read the transcript and ask which disciplines actually produced the outcome. Then — and this is the part that keeps the harness from bloating — **diff against what you already have** before writing anything. Most extracted lessons are restatements. The genuinely new ones get routed: a recurring reactive one becomes kernel, a situational one becomes depth, a one-off becomes a note in your gotchas file.

## What we would tell you before adopting any of it

**Start with the contract template alone.** It is most of the value. The disciplines are worth more once you have run enough tasks to recognise the failures they name — adopted cold, they are just more text.

**Write your own incidents into them.** Every rule here carries the specific failure that produced it, and that is not decoration: a rule with a story attached gets followed, and a rule that reads as generic best practice gets skimmed. Ours will not resonate with your team. Yours will.

**Delete aggressively.** A harness that only grows is a harness on its way to being ignored. The budget is what forces the deletions, and forcing them is the entire mechanism.

---

Part of the [TLDR-G](https://tldr-g.ai) primitives drop. Apache-2.0 — take it, fork it, strip it for parts.
