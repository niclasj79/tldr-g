# Method extraction

**Fires after:** a task that went unusually well or unusually badly, a debugging session that took far longer than it should have, or a run where you caught something a check should have caught.

**Does not fire:** routinely. Extracting a lesson from every task is how a harness bloats to the point of being ignored.

---

## What it is

Read back over what actually happened, and ask which *disciplines* produced the outcome — not what the code did, but what the working method did. Then write down only the part that would change behaviour next time.

This is the loop that lets a harness improve itself. It is also the loop most likely to make it worse, so it has a gate.

## The gate: diff before you write

**Before adding anything, check whether you already have it.**

Most extracted lessons are restatements of rules you wrote months ago in different words. Adding the restatement is actively harmful: two documents saying almost the same thing means neither is authoritative, and the first time they drift, both become untrustworthy.

So: search your existing rules for the lesson *first*. Then one of three things is true.

- **Already covered.** Do nothing. Optionally sharpen the existing wording with the new example — an old rule with a fresh incident attached gets followed again.
- **Covered but did not fire.** The most valuable outcome. The rule was right and something stopped it applying — the trigger was too narrow, it lived somewhere nobody reads, or it was written as advice rather than a check. **Fix the trigger, not the content.** A rule that exists and does not fire is worse than no rule, because it creates the belief that the case is handled.
- **Genuinely new.** Write it, and route it.

## Routing

Where it goes determines whether it ever fires again:

| The lesson is… | It belongs… |
|---|---|
| Reactive, recurring, cheap to check | **Always-on.** Must displace something — respect the budget. |
| Situational, needs depth, has a nameable trigger | **A depth document**, with its trigger written as carefully as its content. |
| A one-off environmental trap | **A gotchas note.** Not a rule; a thing that cost you hours once and will again. |
| Interesting but not behaviour-changing | **Nowhere.** This is the hardest and most important call. |

That last row is the one people skip. "Interesting" is not the bar — *would this have changed what I did* is the bar. A harness full of interesting observations is a harness nobody reads.

## Write the incident in

Every rule should carry the specific failure that produced it. Not for provenance — for **compliance**. A rule that reads as generic best practice gets skimmed. A rule that says *"an $8–12 estimate hit $60 on a 20-instance slice because nobody read the call path"* gets followed, because the reader can picture it.

**And then keep the number honest.** Ours drifted: the run above was recorded as having *cost* $900, when $900 was the projection it was aborted before reaching and the actual spend was ~$60. That wrong figure sat in about thirty places — including outbound drafts — for four months. It had even been caught once, three months in, corrected in the single document where it was noticed, and never swept.

Two lessons, and the second is the one people miss. **A vivid number is load-bearing, so it has to be right** — the whole reason to attach an incident is that people repeat it, which means an error propagates exactly as fast as the rule does. And **a correction is not done when the instance is fixed; it is done when the repository is swept.** Fix it where you found it and you have left the wrong version in every place you did not look — which are, by definition, the places nobody was looking.

## Periodically, go the other way

After enough extractions, ask the inverse: which rules have never fired? Which fire constantly and get waved off every time?

A rule waved off twice with the same justification is not a rule, it is noise — and noise is what teaches people to ignore the surface it lives on. Either sharpen its trigger or delete it. Deleting is usually right.

---

Part of the [TLDR-G](https://tldr-g.ai) agent-harness starter kit. Apache-2.0.
