# TLDR-G Visual Demo

**Render, don't retrieve.**

A sovereign knowledge engine renders the shortest sufficient view of a graph, keeps the topology
intact, and hands you a signed evidence trace you can inspect.

This is the instrument that makes that sentence visible: a four-rung knowledge terrain
you can descend, a command bar that spends a stated token budget in front of you, and a receipt for
every answer that can be verified without trusting the application that produced it.

**It is live at [tldr-g.ai/visual-demo](https://tldr-g.ai/visual-demo/).**

## What this is, and what it is not

It is the engine's **architecture with the hood up** — not a tour of how the product is used. You
watch a budget being spent and then audit the spend. Everything you see is real behaviour of a real
instrument; what it is running *on* is not real.

- **The corpus is synthetic.** Every document, entity, relation and answer was manufactured by a
  seeded generator, and every response the engine returns is stamped `synthetic-design-concept`.
- **The engine underneath is not the TLDR-G engine.** It is a small self-contained one written for
  this demo, so nothing here is evidence about the real engine's performance.
- **The signing key authenticates nothing.** It is derived from a constant in the source, under a
  DID in the reserved `.example` domain that can never be registered. It exists so a reviewer can
  reproduce a signature offline — not so anything can be trusted for carrying one.

> **The trust code in this directory must never be reused for real verification.** It is built to be
> worthless on purpose. The real verifier is `verify.html` and `tp-vrg-verify` at the root of this
> repository — a separate implementation with a real identity. A verifier that shares an artifact
> with the thing that fabricates the data cannot be independent, and independence is the entire
> claim.

---

## Run it

```
npm install && npm run dev
```

Then open the address the dev server prints. No configuration, no API key, no network: the corpus is
generated in-process on first load.

| Command | What it does |
| --- | --- |
| `npm run dev` | The product. |
| `npm run build` | Type-check the project and produce a production build. |
| `npm run typecheck` | Types only. |
| `npm run check` | The discipline linter — the falsifiable half of the design review, run as code. |
| `npm run shots` | Drives the real app through every named screen and writes screenshots. |
| `node scripts/corpus-report.mjs` | Measures the generated corpus and prints its actual counts. |
| `node scripts/verify-trust.mjs` | Rebuilds the corpus, signs a trace, tampers with real bytes, reports what happened. |
| `node scripts/verify-api.mjs` | Calls every client method against the bundled corpus, then against a real HTTP server. |
| `node scripts/verify-state.mjs` | Exercises the state machine headlessly against the real engine. |
| `node scripts/verify-atlas.mjs` | Drives real rung descents and measures the choreography and the naming budget. |
| `node scripts/verify-motion.mjs` | Proves nothing animates without a state change, in full motion and reduced. |
| `node scripts/verify-interaction.mjs` | Real wheel, drag and keystrokes against the real camera. Needs `npm run dev` on :5173. |
| `node scripts/bench-bake.mjs` | Measures layout bake time, determinism and re-bake drift. |

Everything except `verify-interaction.mjs` runs against a built preview; start one with
`npm run build && npm run preview` before `npm run shots`.

Point `VITE_TLDRG_BASE_URL` at an origin that speaks the engine's paths and the same build talks to
it over HTTP instead. Nothing else changes — that claim is the reason `scripts/verify-api.mjs`
exists.

---

## What you are looking at

A corpus of documents, laid out as terrain. Colour is region and it does not change between layouts,
so *the orange island* stays true. Brightness is **resolution** — how much of a node the engine
actually paid for. Three lights carry meaning and nothing else does:

- **cyan** — the engine's attention: selection, the active path, what is being rendered right now.
- **amber** — old light from the sources: citations, hashes, signatures, verbatim spans.
- **violet** — the question light: gaps, unresolved references, what was connected and left out.
- **red** — fail-loud only. If the interface shows red, something is wrong and it says what and what
  to do about it.

A question sits in the command bar **unrun**. That is deliberate. The first render is your act, and
it is the moment the tagline stops being a slogan: you watch the engine choose a resolution per
node, spend a budget doing it, and then account for every choice — including the nodes it reached
and declined to pay for.

---

## The four rungs

The containment spine has exactly four levels. There is no rung above continent, and verbatim
evidence is not a rung — it lives inside a passage as its source segment.

| Rung | Glyph | What it is |
| --- | --- | --- |
| **continent** | ◆ | A top-level semantic region. Washed in its community hue, readable from maximum zoom-out with no labels. |
| **island** | ⬢ | A coherent cluster of documents. Islands are what **straits** run between. |
| **asset** | ▮ | One authored artifact with a **declared boundary** — a contract, a paper, a thread, a merged change, a chapter, a dated session. The molecule, the unit of resolution, and the context extraction happens inside. |
| **passage** | · | A verbatim span inside a document, with character offsets into its source and a hash over exactly those bytes. |

Crossing the spine is only half the structure. **Entities** are the cross-cutting layer above it —
the named concepts, reconciled across documents. An entity mentioned in documents on two different
islands is a **bridge entity**, and a path through it physically crosses a strait on screen. Without
the entity layer the terrain is four disconnected zoom levels; with it, the terrain has routes.

---

## The resolution ramp

Five tiers. Every node on screen is at exactly one of them, and the tier is a spending decision by
the engine rather than a consequence of zoom.

| Tier | Place | Meaning |
| --- | --- | --- |
| **lod-0** | fovea | Verbatim. Read to you in full, byte for byte. The only tier a citation may rest on. |
| **lod-1** | penumbra | Summary. Enough of the node to reason with, never enough to quote. |
| **lod-2** | periphery | Label and identifier. Enough to point at and navigate to. |
| **ghost** | — | Present in the terrain, not spent on. Label on hover only. |
| **latent** | — | Outline only: known to exist, resolved to nothing. |

**Latent is load-bearing.** It exists so the terrain never has holes. Descending from the island rung
into one document does not delete the rest of the world, it demotes it — the whole bake stays
resident in the point cloud at all times. Content the engine omitted is still there, in its real
position, at its real size, as topology. Omission is a budget decision, not a deletion, and latent is
what makes the decision visible instead of invisible.

---

## The trust model

Three mechanisms, each of which can be checked rather than believed.

### 1. The signature

Every render produces a `visual-demo-trace-v1`: the question, what produced the answer, every quote with
the hash of the source bytes behind it, every node admitted with its cost and its reason, and
everything connected that was **not** admitted. The whole payload is hashed and the hash is signed
with a detached Ed25519 signature.

Verification runs **locally**, even when a live engine is configured — you do not ask the party that
produced a receipt whether the receipt is good. Both halves are checked and reported separately,
because which half fails is the diagnosis:

- alter a quote → the payload hash stops matching, the signature still verifies. *The content moved.*
- alter the signature → the hash still matches, the signature does not verify. *The header was touched.*

The receipt panel ships a control that mutates the real bytes and re-runs verification for real — not a mocked badge. It has
to be real, or it teaches the wrong lesson.

### 2. Resolution disclosure

A passage's rendered text is not always byte-identical to the document. It can be
*coreference-resolved* (pronouns replaced with their referents) or *term-resolved* (aliases
normalised to canonical names). Both are useful. Both are no longer literally what the document says.

So every quote states its distance from the source — **including the ones that have not travelled at
all**. A label that only appears when something is awkward reads as an admission; a label that is
always present is a method. The character offsets still recover the original bytes, and the hash is
always computed over those bytes, never over the text as displayed.

### 3. The truth gate and quarantine

A relation is admitted when its extraction confidence clears the declared floor and it carries at
least one evidence passage. Structural relations — reading order, co-document membership, session
ordering — are **exempt**, because they describe the artifact rather than the world: `_follows` says
"this passage came after that one in the document", and there is nothing about that to verify.
Gating them would quarantine the graph's own skeleton and the terrain would fall apart into dust.

Rejected claims are **not** deleted. They ship in the payload and render latent, so the terrain shows
what was thrown out. They are never traversed and may never carry an answer: a route through a
rejected claim is not a shorter answer, it is a wrong one. Every rejection carries a named code, and
the Integrity panel groups by those codes so you can go and look at what was rejected and why —
including the exempt structural count, reported separately so the exemption cannot quietly inflate
the pass rate.

### And the number the whole thing is for

The receipt reports what the render cost, and what the naive alternative would have cost: every
passage of every document the constellation touches, summed from the corpus's own per-passage token
counts. That counterfactual is a measured inventory, not an estimate, and the savings figure is
computed from those two numbers and nothing else.

---

## Controls

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
| `1` `2` `3` `4` | Jump to the continent / island / asset / passage rung |
| `Backspace` | Ascend one rung |
| `Esc` | Clear focus and selection |

Pointer: hover to preview, click to select, double-click to descend. The keyboard map is data
(`src/state/keys.ts`) — the handler dispatches from it, the help overlay is generated from it, and
every key hint in the product reads its glyphs out of it, so a shortcut and its label cannot
disagree.

---

## Architecture

```
src/engine/     the contract: schema, client, corpus generator, layout bake, trust
src/state/      the store, the state machine, the resolution derivation, the scene hook
src/graph/      the WebGL2 terrain: wash, edges, points, labels, camera, picking
src/ui/         primitives, panels, the shell
src/copy/       every user-visible string, and the glossary
src/styles/     design tokens — the only place a colour, duration or radius is defined
```

**One client, two transports.** `EngineClient` has identical signatures and identical response shapes
whether it is serving the in-memory corpus or talking to a live engine over HTTP. The fixture
transport serialises and re-parses every payload, so a component that works against the demo cannot
break the day the base URL is set. The HTTP half is real code — real URL construction, real error
mapping, real abort plumbing — because a seam that has never been exercised is not a seam.

**Position is baked, and read paths never compute layout.** The layout is computed once,
content-addressed by the graph state, and frozen: deterministic semantic features diffused over the
graph, projected with power-iteration PCA, communities laid out as masses with a minimum-separation
floor (that floor *is* the strait), coastlines from a seeded harmonic lobe function, a bounded
relaxation pass, then bottom-up spine reconciliation so a document sits exactly at the centroid of
its passages. There is no force simulation anywhere in this product — no tick loop, no settling, no
"it stabilises after a second". A map that moves while you are reading it destroys the one thing a
terrain is for: spatial memory. When the corpus changes, the new layout is aligned onto the old one
by a rigid transform over shared anchors, and the mean drift that remains is reported rather than
hidden.

**Edges are earned, never all-on.** The corpus generates thousands of relations; drawing them is not
a rendering problem to be solved with better shaders, it is a semantic failure — a picture of
everything is a picture of nothing, and the user learns the map cannot be read. So the policy lives
in the engine seam, where a renderer cannot opt out of it by being clever. Three rules, and every
response says which one it used:

- `trade-route-skeleton` — the high-weight bundled corridors between regions. At the region rungs
  this is the only thing drawn; each corridor reports how many relations it carries and ships a small
  sample of the real ones.
- `hover-neighborhood` — the k-hop neighbourhood of the pointer target, intersected with what is on
  screen. Rejected claims never extend a neighbourhood.
- `query-constellation` — exactly the relations on and adjacent to an answer path.

The interface reports `edges_drawn` against `edge_count`, so it can state how much was withheld
instead of implying that what is on screen is all there is.

**The terrain is four layers and three WebGL draw calls** on one orthographic camera: the community
wash, the earned edges, and one instanced point cloud carrying every node in the bake at all times —
that is the three. The fourth layer is the labels, which live in the DOM — altitude-gated,
centrality-ranked, collision-culled and hard-capped — and cost zero draw calls, which is why the
count is three and not four. `window.__atlas.perf().drawCalls` reads
`renderer.info.render.calls` straight off the renderer and returns **3** in every scene that has a
terrain, unchanged at 100,000 points. The loop is render-on-demand: it schedules a frame when
something actually changed and stops when everything has settled. There is no idle animation, so
there is nothing to animate.

**The interface never lies about the engine.** Every glow corresponds to a real selection, every
meter shows a number the engine produced, and there is no fake progress anywhere. `npm run check`
enforces the mechanical half of that: no hardcoded colour outside the token file, no drop shadows, no
bloom, no live layout on a read path, no measured number rendered outside the monospaced numeric
primitive. The runtime half is checked by `window.__atlas.audit()` during the screenshot pass.

**Screens are driven, not staged.** The app exposes a scene hook that drives the *real* application
into each named screen through the *real* actions — `home` runs the same navigation a click runs,
`receipt` runs the same render the command bar runs, and `degraded` fails for a real reason with the
engine's own remedy attached. A screenshot harness that photographs a mock is a harness that
certifies a lie.

---

## The two states that are not the happy path

Most interfaces treat "nothing here yet" and "it broke" as the places where the design stops. Both
are drawn here on purpose, and both are reachable through real actions rather than staged.

**FIRST RUN** is the latent field: the world at the resolution of *nothing has been spent*. It is not
a splash screen and not a spinner — it is the same claim the terrain makes at every other altitude,
drawn at the tier where nothing has been resolved yet, so the first thing you see is already the
product's thesis. There is no WebGL terrain on this screen, and the audit reports 100% of the window
as unobstructed, because there is no chrome on it to obstruct anything.

**DEGRADED** is a full-width `--alarm` instrument bar, **docked** between the top bar and the body —
not a toast, not a floating card, and never a silent retry. It spans the whole window, it takes its
height out of the body rather than lying on top of the map, and it prints three things: the machine
code in the mono face (`QUERY_NO_MATCH`, `TRANSPORT_FAILED`, `MALFORMED_RESPONSE`, …), the exact
failure in the engine's own words, and the exact remedy *next to the control that performs it*.

There is exactly **one** failure state in the machine, so there is exactly one instrument for it. A
question the corpus cannot answer puts the app in the same DEGRADED a dead transport does, and
answering it with a soft amber card in a corner would be the interface under-reporting its own state.
If a merely-unanswerable question should be treated more gently — and it probably should — that is a
new state in `src/state/machine.ts`, not a coat of paint on this bar.

---

## Demo scripts

Three two-minute paths through the same build, for audiences who already know what they are looking
at. For someone with **no prior context**, [`DEMO.md`](DEMO.md) is the longer first-contact script —
how to frame it before they touch anything, what to tell them to ignore, and the traps that make the
demo fall flat.

### For an investor — *the claim, and the receipt for it*

1. Open on the resting map. One sentence: *the question in the bar has not been run; the engine has
   not spent a token yet.*
2. Press **Q**. The constellation assembles and the terrain dims — everything off the answer path
   drops to ghost, and comes back when the render lands. The answer names an entity that is nowhere
   near the question on the map, because the path crossed a strait through a bridge entity.
3. Press **P**. Read three rows: what the render cost, what stuffing the whole context would have
   cost, and the ratio. Both figures are sums over rows on the same panel.
4. Scroll to **Omitted but connected**. *This is what the engine reached and chose not to pay for,
   and every one of those nodes is drawn latent on the map behind this panel.*
5. Press **Verify** — green, both halves. Then press **Alter a quote**: the real bytes change, the
   verification runs again for real, and the badge goes red with a precise verdict — the payload moved, the
   signature is intact.

Close with: *the answer is not the product. The receipt is.*

### For a designer — *how resolution reads*

1. Start from the empty state. The grid behind the panel is drawn at latent resolution: outline only,
   nothing spent. It is not a placeholder — it is the shape of an unresolved world.
2. Ingest. Watch documents land and the layout settle, then press **A** for Atlas Mode: the same
   world at four rungs at once.
3. Press **1 2 3 4**. Notice what does *not* happen: nothing is deleted and nothing jumps. Hue stays
   constant down the spine, so you always know which region you are in without reading a label.
4. Hover a quiet node. Its label appears; its neighbours' do not. Labels are altitude-gated,
   centrality-ranked and collision-culled, with a hard ceiling — a label storm is a way of showing
   nothing.
5. Press **Q** and watch the fog: dimming is state, not decoration. Then press **?** and read the
   three lights. Every non-neutral colour on screen is one of them or a community hue.

Close with: *there is no bloom, no shadow and no idle motion in this product. Glow is 6px maximum and
it is earned by selection.*

### For an engineer — *where the seams are*

1. In a terminal: `node scripts/verify-trust.mjs`. It rebuilds the corpus, re-derives every citation
   hash from the source bytes, signs a trace, tampers with it, and exits non-zero if a single figure
   has drifted.
2. `node scripts/verify-api.mjs`. Every client method against the bundled corpus, then the same
   client against a real HTTP server over loopback. That is the "base-URL change, not a rewrite"
   claim, falsifiable.
3. `npm run check`. The design rules that can be decided mechanically, decided mechanically.
4. In the app: press **G** for Analyst Mode. The edge-policy readout names which of the three rules
   chose what is on screen, and reports what was withheld. Turn a σ-class off and note that the
   payload does not change — filtering narrows what is stroked, never what exists.
5. Open the receipt and press **Explain the path**. The graph is re-traversed between the answer's
   own endpoints, without looking at the receipt, and the two are compared. A disagreement degrades
   the app on purpose: two panels contradicting each other about the same two nodes is the failure
   this product cannot afford.
6. Open **Integrity**. The truth gate's own report card, including the structural exemption counted
   separately.

Close with: *the corpus is deterministic from a seed, so every hash on screen is reproducible, and
every number in the receipt is a sum over an array you can print.*

---

## The honest notes

**The corpus is synthetic.** Every document, entity, relation, date, quote and answer in this build
was manufactured by a seeded generator. The engine stamps `corpus_provenance:
'synthetic-design-concept'` on every response it returns, and the interface surfaces that rather than
filtering it out. **Every figure on screen is a design concept.** A synthetic receipt that looks like
a real one is a forgery regardless of intent.

What is *not* synthetic is the instrument. Traversal is real, the token budget really binds, the
hashes are real SHA-256 over the verbatim bytes, the signatures are real Ed25519, and the latency
readout is a real `performance.now()` delta around the whole call. The fixture transport applies one
declared wire model derived from the payload's real byte count, and it can be switched off; that is
the only synthetic millisecond in the client.

**There is no embedding model in this build.** `render_confidence.semantic` is specified as
embedding-space fit between the question and the admitted passages. What is actually measured is the
share of the question's content terms that literally appear in the cited text. It is a weaker signal
than a cosine and it reads low on paraphrase — which is the correct direction for a substitute to
err. The row that displays it says so.

**Free-text questions are matched lexically** against entity labels and aliases, not against meaning.
Ask about something the corpus does not name and the engine refuses with a named error and a remedy,
rather than producing a confident paragraph with nothing underneath it.

**The counts in this README are deliberately absent.** Run `node scripts/corpus-report.mjs` and it
will measure the corpus you actually have. A document that quotes a figure is a document that will
one day disagree with the instrument standing next to it.

---

## Licence

See `LICENSE`.
