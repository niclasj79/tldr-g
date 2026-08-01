# Search before invent

**Fires when:** you are about to write a quick fix, a workaround, a special case, a threshold bump, or a patch "for now."

**Watch for the phrasing.** It announces itself: *"let me just…"*, *"quick fix"*, *"raise the limit"*, *"add a special case"*, *"temporarily"*, *"for the time being"*. When one of those appears in your own reasoning, this discipline has fired.

**Also fires when:** you are about to implement a spec that has been sitting unbuilt for more than a month or so while other things shipped. Its premises may have expired. Re-read it against what now exists before building it as written.

**Does not fire for:** unambiguous small bugs where a search would obviously return nothing — a typo, an off-by-one, a wrong variable name. The discipline is for solution-shaped problems, not for typos.

---

## The failure it prevents

A capable agent's default move is to **generate** a solution rather than **retrieve** one. This is usually right and occasionally expensive: the expensive case is when a careful design for exactly this problem already exists in your own repository, written by you, and the agent reinvents a worse version because generating is cheaper than looking.

The symptom is a codebase with two mechanisms for one job — the designed one and the patched one — and no record that the second was ever a decision.

The other half is the crash-fix reflex. A limit is exceeded, so the limit gets raised. That fixes the crash and leaves the actual constraint undocumented, so it recurs at the next scale.

## The loop

1. **Name the problem in one sentence**, without naming your intended fix. If your sentence contains the fix, rewrite it.
2. **Search your own corpus** for that problem — design notes, architecture docs, the rules directory, whatever parking lot or idea file you keep, the gotchas file, and closed issues. Search for the *problem*, not for the fix you had in mind, or you will only find things that agree with you.
3. **Read what you find, in full.** A design note that half-covers the case is more useful than a fresh idea, and knowing why it was not built is often the actual answer.
4. **Then decide, explicitly:**
   - **Adopt** — the design exists; implement that.
   - **Adapt** — it exists but its premises changed; note what changed, then adapt.
   - **Invent** — nothing covers it; say so, and write down what you searched. That sentence is what stops the next person repeating the search.

## Why the search order matters

Search for the **symptom and the constraint**, not the remedy. "Chunks exceed the model's context window" finds the note about embedding truncation. "Increase chunk limit" finds nothing, because nobody ever wrote a note recommending that.

## The tell that it is working

You will start finding things you wrote and forgot. That is not embarrassing; it is the discipline paying out. A design corpus you do not search is a design corpus you did not need to write.

---

Part of the [TLDR-G](https://tldr-g.ai) agent-harness starter kit. Apache-2.0.
