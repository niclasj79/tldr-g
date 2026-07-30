# Demoing the visual demo

A script for showing this to someone who has never heard of TLDR-G.

The interface is dense on purpose, and a newcomer left to explore it alone will read twenty
instruments before asking one question — which is the wrong order and loses them. This document is
the order that works.

**This is the first-contact script**, for someone with no prior context, and it runs about ten
minutes. The README's *Demo scripts* section holds three **two-minute** paths for audiences who
already know what they are looking at — investor, designer, engineer. Use those when the audience
arrives with a frame. Use this one when they do not.

**No figures are quoted anywhere below.** The receipt is open beside you showing the real ones, and
prose that restates a derived number is a lie waiting for the next corpus change.

---

## Frame it before they touch anything (~20 seconds)

- **Say the problem first, not the product.** *"You have hundreds of documents. The answer to your
  question is in two of them, and those two never mention each other. Search gives you keywords. RAG
  stuffs a context window and hopes. Neither shows you what it ignored."*
- **Then one line about what this is:** *"This renders the shortest sufficient view of a graph, and
  hands you a receipt for it."*
- **Set the honesty frame immediately.** It buys credibility and pre-empts the obvious objection:
  *"The corpus is synthetic and the app says so on every screen. The instrument is not — real
  hashes, real signatures, real traversal, real token accounting."*
- **Do not open with the architecture.** Rungs, σ-classes and resolution tiers mean nothing yet.
  They become self-evident after the first render.

## The persona to hand them

- They are an **analyst doing due diligence on a Nordic energy-infrastructure archive** — contracts,
  technical papers, board sessions, incident reviews.
- Their question: *which parent company ends up owning this facility?* — where the ownership chain
  runs through an intermediate operator and no single document states it end to end.
- That is the real shape of the work: multi-hop, buried, and expensive to answer by hand.

## What to tell them to ignore

Give explicit permission to look at **three things only**:

- the **map** (centre)
- the **question bar** (top)
- the **big number** in the receipt, after they run it

Say: *"the bottom strip is a telemetry cluster, like a cockpit HUD. Ignore it until we've asked
something."* Without that permission newcomers try to read everything at once and disengage.

---

## The beats, in order

### 0 — The empty state
One button: **Ingest the bundled corpus and bake the layout.** No login, no API key, no network
call — the corpus is generated in-process. Click it.

### 1 — The terrain at rest
- **Say: "This is the entire corpus. Nothing has been asked yet."** That is the whole beat.
- **Colour is region**, and it is stable across layouts — the orange island stays the orange island.
  Spatial memory is the point.
- **Brightness is resolution** — how much of a node the engine actually paid for. Almost everything
  is dim, because nothing has been spent.
- Open the **Corpus** panel: the four rung counts, the **bake id**, and a content hash. Position is
  frozen and content-addressed; the map does not drift between sessions.
- The strongest line here: *"There is no force simulation. Nothing settles, nothing wobbles. A map
  that moves while you read it destroys the only thing a map is for."*

### 2 — The staged question (do not rush this)
- The question sits in the command bar **unrun**, labelled *"Staged, not rendered. The engine has
  not spent a token on this yet."*
- **This is the most important beat in the demo.** Say: *"Every RAG demo you have seen already ran.
  This one is waiting for you. The first render is your act."*
- Note the five **intent chips** — Bridge · Lookup · Compare · Timeline · Summarise. The staged
  question is classified **Bridge**, because it is two hops through an entity mentioned on two
  different islands.
- The Inspector says *why the question is there*: the answer path physically crosses a **strait**.

### 3 — Render it
- Press **`Q`**, or click **Render**.
- **Watch the map, not the text.** Selected nodes light in cyan and the answer path draws across the
  gap between two land masses.
- Then the token meter **counts down** from the stuffed-context figure to the rendered figure, once.
- Say: *"That countdown is not an animation. It is the state transition — one number became the
  other because the engine spent one and not the other."*

### 4 — The receipt (`P`)
Walk these in order. Each has a customer meaning:

- **Token budget** — rendered vs stuffed context. The counterfactual is a *measured inventory* of
  every passage of every document the answer touched, not an estimate. This is the ROI slide, and it
  is computed rather than claimed.
- **Resolution spent** — how many nodes at verbatim, summary and label. The proof it did not just
  dump everything it could reach.
- **Citations** — each with a **content hash**, character offsets, token cost, and *"admitted
  because"* in engine terms.
- **"Rendered at"** on each citation — verbatim, coref-resolved or term-resolved. Say: *"every quote
  states its distance from the source, including the ones that have not moved at all. A label that
  only appears when something is awkward reads as an excuse; always-on is a method."*
- **Omitted but connected** — **the sleeper hit of the whole demo.** Nodes one hop from the answer
  that the engine *declined to pay for*, each with a reason and a hop distance.
  > *"This is the list nobody else shows you. Every other system tells you what it used. This tells
  > you what it saw and chose to skip, so you can judge whether it was right."*

  For a regulated buyer this is usually the moment they lean in.

### 5 — Break it on purpose (the closer)
- In the receipt: **Break it on purpose** — *Alter a quote · Alter the signature · Alter the signer.*
- Press **Alter a quote**, then **Verify**. The result names *which half broke*:
  - quote altered → payload hash stops matching, signature still verifies → **the content moved**
  - signature altered → hash still matches, signature fails → **the header was touched**
- The line that lands: *"Verification runs locally, in your browser. You never ask the party that
  issued a receipt whether the receipt is good."*
- This mutates **real bytes** and re-runs the **real** verifier. Say so — it is the difference
  between a demo and a cartoon.

### 6 — Independent re-derivation
- In the answer panel press **Explain the path**.
- The graph is re-traversed between the answer's own endpoints **without looking at the receipt**,
  and the two are compared.
- **If they disagreed the app would degrade itself on purpose.** Say that out loud: two panels
  contradicting each other about the same two nodes is the failure this product refuses to ship.

### 7 — The rungs: zoom changes what things *are*
- **`1` `2` `3` `4`** jump to continent · island · asset · passage. **`Backspace`** ascends.
  **Double-click** descends into whatever you are pointing at.
- Say: *"This is not magnification. At each level the map is made of different objects."*
- Descend to a **passage** and show the verbatim text with its hash and offsets: *"the bottom rung
  is the actual source bytes. Slice the document at those offsets, hash it, and it matches."*
- **`A`** opens **Atlas Mode** — all four rungs at once. The best single screenshot of the model.

### 8 — Nothing is hidden (`G`, Analyst Mode)
- Names which of the three edge rules drew what is on screen: **trade-route-skeleton** (bundled
  corridors between regions), **hover-neighborhood** (k-hop around the pointer), and
  **query-constellation** (exactly the answer path and its neighbours).
- Toggle a **σ-class** off — Topology, Temporal or Authorial.
- **The point: the payload does not change.** Filtering narrows what is *stroked*, never what
  *exists*. The HUD reports edges drawn against the total, and how many were withheld.
- *"Drawing every relation is not a rendering problem to solve with better shaders. It is a semantic
  failure — a picture of everything is a picture of nothing."*

### 9 — Integrity (for a regulated audience)
- The truth gate's report card. A relation is admitted only when extraction confidence clears the
  declared floor **and** it carries at least one evidence passage.
- **Rejected claims are not deleted.** They ship in the payload and render **latent** — visible,
  never traversed, and never able to carry an answer.
- Structural relations (reading order, co-document membership) are **exempt and counted
  separately**, so the exemption cannot quietly inflate the pass rate. That separate count is itself
  the trust signal.

---

## Reading the HUD, once they ask

- **Rendered / Saved** — tokens spent, and the share saved against stuffing.
- **Last call** — a real `performance.now()` delta around the whole call, not a spinner.
- **Response cache** — hits in the *client*. Distinct from the receipt's **render cache**, which is
  the engine's memo *within a single render*. The tooltips say so: they count different work and
  must not be read as one number.
- **Nodes / Stroked / Relations / Withheld** — what exists against what is drawn.
- **Resolution** — live counts per tier: fovea (verbatim) · penumbra (summary) · periphery (label) ·
  ghost (present, unpaid for) · latent (outline only).
- **`latent` is load-bearing.** It exists so the terrain never has holes. Omission is a budget
  decision, not a deletion, and latent is what makes the decision visible.

## Keys

| Key | Action |
| --- | --- |
| `/` | Command search |
| `Q` | Render the staged question |
| `A` | Atlas Mode — all four rungs at once |
| `I` | Inspector |
| `P` | Provenance — the render trace |
| `T` | Timeline |
| `G` | Analyst Mode |
| `?` | Keyboard map and glossary |
| `1` `2` `3` `4` | Jump to a rung |
| `Backspace` | Ascend one rung |
| `Esc` | Clear focus and selection |

Arrow keys move focus to the nearest node **in that direction** — cone-constrained, so "right" never
means "up". Hover previews, click selects, double-click descends. There is also a share control that
copies a link reconstructing the exact view.

## The other staged questions

Each has a by-construction answer, so the engine can be **scored** rather than admired. One per
intent class, and each states its own *why* in the Inspector:

- **Lookup** — one hop, one citation. The floor case: the engine should spend almost nothing.
- **Compare** — two subjects joined by one shared object. The constellation should be a **fork**,
  not a chain.
- **Timeline** — dated sessions put in order, with what changed between them.
- **Summarise** — what one record establishes about one company.

Running Lookup straight after Bridge is a good move: the same instrument, an order of magnitude less
spent, and the receipt proves it.

## Traps that make the demo fall flat

- **Do not type a free-text question about something the corpus does not name.** Matching is
  **lexical**, not semantic — there is no embedding model in this build. It refuses with a named
  error instead of bluffing. That refusal is worth showing *on purpose*, but not worth stumbling
  into.
- **Do not skip the unrun-question beat.** Running it immediately destroys the argument.
- **Do not present the numbers as product benchmarks.** They are a design concept on a synthetic
  corpus.
- **Do not oversell render confidence.** Its semantic component is a lexical substitute for
  embedding fit and reads low on paraphrase. The row that displays it says so.

## Three sentences to close on

- *"The corpus is synthetic. The instrument is not."*
- *"Everything here is reproducible from a seed, so every hash is checkable and every number is a sum
  over an array you can print."*
- *"This is a design concept for the interface. The engine behind it is real, runs locally, and this
  is what it looks like pointed at your documents."*

---

## If you want to prove it rather than assert it

Each of these runs in a terminal and either passes or fails:

| Command | What it settles |
| --- | --- |
| `node scripts/corpus-report.mjs` | Measures the corpus you actually have, rather than trusting a figure in a document. |
| `node scripts/verify-trust.mjs` | Rebuilds the corpus, signs a trace, tampers with real bytes, and exits non-zero if a figure drifted. |
| `node scripts/verify-api.mjs` | Every client method against the bundled corpus, then the same client against a real HTTP server. |
| `npm run check` | The design rules that can be decided mechanically, decided mechanically. |
