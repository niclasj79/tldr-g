# Cost gate

**Fires before:** recommending, scheduling, or executing any operation that makes more than a handful of priced API calls — a benchmark sweep, a batch extraction, a bulk summarization, an LLM-as-judge run, a re-embedding job. Also fires whenever someone asks *"what will this cost?"*

**Does not fire for:** paths with no per-call price — local models, mock providers, cached runs, a `--dry-run`. Nor for single-digit call counts.

---

## The incident

A benchmark run was estimated at **"$8–12"**, with **$4** budgeted for a 20-instance slice. The slice actually cost about **$60**, and the run was **aborted** there — extrapolated, the full run was tracking toward **$900**.

Nothing exotic went wrong. The estimate was made by feel, from the shape of the job — a plausible number of units times a plausible cost per unit. What it missed was that the code path made roughly nine calls per unit rather than one. None of that was hidden. Nobody read it.

**15× on what was actually spent, and about 100× on where it was heading.** That is not a bad estimate. It is a *different kind of thing* from an estimate — it is a guess about code that was never opened.

Worth being precise about which number is which, because we got this wrong ourselves: **$60 was spent, $900 was avoided.** For four months our own notes said the run "cost $900", collapsing the projection into the spend, and that wrong figure spread to about thirty places before someone caught it a second time. The accurate version is also the more useful one — it is a story about a limit being caught at $60, not about $900 disappearing.

## The pre-flight

Four steps, in order, before any priced batch:

1. **Read the code path that makes the calls.** Not the entry point — the loop. How many calls per unit of work? Are there retries? Is there a second pass, a judge, a validation call, an embedding step?
2. **Read the response schema.** Token counts drive cost, and output length is usually where the surprise lives. A structured output with a long schema is not a cheap call.
3. **Anchor to a real prior run.** If something similar has run before, use its *measured* cost per unit. An anchor beats a model of the pricing page.
4. **Count with arithmetic, written down.** `units × calls-per-unit × (input + output tokens) × price`. Write the multiplication out. If you cannot fill in a term, that is the term to go and read.

## The canary

**If the estimate exceeds a threshold you set in advance — ours is $5 — run three units first.** Measure the real cost. Multiply. Then decide.

Three units cost cents and turn every unknown above into a measurement. The canary is not caution; it is the cheapest way to convert a guess into a number.

## The confirmation

Above the threshold, the person paying confirms explicitly, and they confirm **a number with its arithmetic shown** — not a range, and not a vibe. "About ten dollars" is what that run was approved as.

## Why this is a standing rule and not a habit

Because it fires exactly when you are least inclined to follow it: you have finished the interesting work, the run is the boring last step, and pausing to read a call path feels like procrastination. That is the moment the rule is for.

---

Part of the [TLDR-G](https://tldr-g.ai) agent-harness starter kit. Apache-2.0.
