/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE COPY DECK
 * =============================================================================
 *
 * EVERY USER-VISIBLE STRING IN THE PRODUCT LIVES HERE.
 *
 * No component hardcodes prose. That is not a tidiness rule — it is the only way
 * the product speaks with one voice, and the only way a reviewer can read the
 * whole product's claims in one sitting and check them against the engine.
 *
 * -----------------------------------------------------------------------------
 * THE VOICE
 * -----------------------------------------------------------------------------
 * A serious instrument. Short, declarative, specific. It explains by NAMING
 * things precisely rather than by exclaiming. It volunteers limitations, because
 * a system that tells you where it is weak is the only kind you can calibrate
 * against. It never sells and it never apologises.
 *
 * Three tests every line here has to pass:
 *   1. Could the engine contradict it? If yes, it is wrong — fix the line, not
 *      the engine.
 *   2. Does it contain a number this file invented? If yes, delete the number.
 *      Numbers come from the engine, through the mono primitive, or not at all.
 *   3. Would a stranger know what the control does before pressing it?
 *
 * -----------------------------------------------------------------------------
 * WHAT THIS FILE MAY NOT DO
 * -----------------------------------------------------------------------------
 * It may not state a measurement. There is not one figure in this deck. Where a
 * sentence needs a quantity, it names the field the quantity comes from and
 * leaves a hole for `<Num>` to fill. A copy deck that quotes a number is a copy
 * deck that will one day disagree with the instrument standing next to it.
 * =============================================================================
 */

import type {
  AppState,
  BoundaryKind,
  DensityMode,
  DrawnReason,
  LodState,
  NodeKind,
  PassageResolution,
  QueryIntent,
  QueryMode,
  QuarantineReason,
  Rung,
  SigmaClass,
} from '@/engine';

import type { KeyActionId, KeyGroup } from '@/state/keys';

import type { ActionCopy, FailureCopy, RowCopy, StateCopy, TermCopy } from '@/copy/types';

/* =============================================================================
 * 1. THE PRODUCT
 * ========================================================================== */

const product = {
  name: 'TLDR-G Visual Demo',
  short: 'Visual demo',
  /** The tagline. It is a claim about mechanism, not a slogan. */
  tagline: 'Render, don’t retrieve.',
  /** The thesis, in one sentence. Used on FIRST-RUN and in the help overlay. */
  thesis:
    'A sovereign knowledge engine renders the shortest sufficient view of a graph, keeps the topology intact, and hands you a signed evidence trace you can inspect.',
  /** The mechanism, in one line, for people who want the how before the why. */
  mechanism:
    'Four rungs, one baked layout, five resolutions, and a receipt for every answer.',
  /** What the tagline means, when there is room to say it. */
  taglineGloss:
    'Retrieval finds passages and hands you the pile. Rendering decides, per node, how much resolution the question is worth — and then shows you the decision.',
} as const;

/* =============================================================================
 * 2. PROVENANCE OF THE DEMO ITSELF
 * -----------------------------------------------------------------------------
 * The synthetic-corpus marker. It is worded as a statement of method, because
 * that is what it is: the world is generated, the instrument is not. Hiding this
 * would make a synthetic receipt look like a real one, which is a forgery even
 * when the forger meant well.
 * ========================================================================== */

const provenance = {
  /** The chip that sits wherever generated content is shown. Two words, always visible. */
  badge: 'synthetic corpus',
  /** The engine's own field name, shown next to the badge so the claim is checkable. */
  field: 'corpus_provenance',
  /** The value the engine stamps on every response envelope. */
  value: 'synthetic-design-concept',
  /** One line. Goes under the badge, in the receipt header, and on the answer. */
  short: 'Every document, answer, quote and figure in this build is generated. Design concept.',
  /** The full statement. Help overlay, receipt disclosure, README. */
  long:
    'The corpus is a generated Nordic energy-infrastructure archive: the documents, entities, relations and dates were manufactured by a seeded generator and are reproducible byte for byte. The engine over it is not generated. Traversal is real, the token budget really binds, the hashes are real SHA-256 over the verbatim bytes, and the receipt is really signed. What is synthetic is the world, not the instrument.',
  /** Why it is stamped rather than mentioned once in a footer. */
  why:
    'The engine stamps corpus_provenance on every response it returns, and this interface surfaces it rather than filtering it out. A receipt that looks real and is not is worse than no receipt.',
  /** Shown beside a gold answer, which is staged by construction. */
  staged:
    'This question was set up in advance and has a by-construction answer, which is why the engine can be scored against it.',
} as const;

/* =============================================================================
 * 3. THE TOP BAR
 * ========================================================================== */

const topbar = {
  brand: {
    name: product.name,
    tagline: product.tagline,
    title: 'TLDR-G Visual Demo — render, don’t retrieve',
  },
  corpus: {
    label: 'Corpus',
    tip: 'The ingested archive this terrain was baked from.',
    none: 'none loaded',
  },
  engine: {
    label: 'Engine',
    fixture: 'bundled corpus',
    live: 'live engine',
    tip: 'Which transport the client is talking to. Swapping the bundled corpus for a live engine is a base-URL change; every response shape stays identical.',
  },
  bake: {
    label: 'Bake',
    tip: 'The frozen layout every coordinate on screen is expressed against. Nothing moves between bakes — that is what makes the map worth remembering.',
    drift: {
      label: 'Anchor drift',
      tip: 'Mean displacement of the anchor nodes after the new layout was aligned to the old one. It is the instrument confessing how much your spatial memory actually broke.',
      unit: 'u',
    },
    stale: 'Stale bake — the positions on screen were computed from different bytes.',
  },
  rung: { label: 'Rung', tip: 'Which of the four rungs of the containment spine you are reading.' },
  breadcrumb: {
    label: 'Descent',
    root: 'World',
    rootTip: 'The set of continents. There is no rung above this one.',
    tip: 'Where you are on the spine. Click any step to return to it.',
    ascend: { label: 'Up', title: 'Ascend one rung' } satisfies ActionCopy,
  },
  latency: {
    label: 'Last call',
    tip: 'Wall-clock milliseconds around the most recent engine call, measured by the client. Never animated, never smoothed.',
    unit: 'ms',
  },
  cache: {
    label: 'Response cache',
    tip: 'Real hit and lookup counters on the client’s response cache, keyed by bake. This is a different counter from the engine’s own render cache on the receipt; the two count different work.',
  },
  panels: { label: 'Panels' },
  help: { label: 'Help', title: 'Keyboard map and glossary' } satisfies ActionCopy,
  close: { label: 'Close corpus', title: 'Unload the corpus and return to the empty state' } satisfies ActionCopy,
} as const;

/* =============================================================================
 * 4. THE COMMAND BAR
 * -----------------------------------------------------------------------------
 * THE MOST IMPORTANT COPY IN THE PRODUCT.
 *
 * The staged question sits in the bar UNRUN. Nothing has been rendered. The
 * first render is the USER'S ACT, and that is the moment "render, don't
 * retrieve" stops being a tagline and becomes something they watched happen.
 *
 * So the control is not a search box and must not read like one. The button says
 * RENDER because render is the verb the engine performs; the hint says the
 * engine has not run yet, because it has not; and the budget is named on the way
 * in, because spending is the thing about to be observed.
 * ========================================================================== */

const command = {
  label: 'Question',
  placeholder: 'Name something on the map and ask what it is joined to.',
  /** The at-rest state: a question is loaded, the engine has not moved. */
  staged: {
    badge: 'staged',
    /** Sits under the bar before the first render. This is the ten-second line. */
    hint: 'Staged, not rendered. The engine has not spent a token on this yet.',
    /** The invitation. Operating an instrument, not submitting a form. */
    prompt: 'Render it and watch what the engine chooses to spend on.',
  },
  run: {
    label: 'Render',
    title: 'Render this question against the graph and return a signed trace',
  } satisfies ActionCopy,
  rerun: { label: 'Render again', title: 'Discard this render and run the question again' } satisfies ActionCopy,
  running: {
    label: 'Rendering',
    /** What is actually happening, named. No fake progress, no percentage. */
    note: 'Traversing admitted relations, admitting nodes against the budget, costing every one.',
  },
  clear: { label: 'Clear', title: 'Empty the command bar' } satisfies ActionCopy,
  budget: {
    label: 'Token budget',
    tip: 'The ceiling the renderer is given. It is not a suggestion: admission stops at the node that would cross it, and everything past that point is reported as omitted.',
    unit: 'tok',
  },
  mode: {
    label: 'Mode',
    tip: 'How the answer is produced. Deterministic mode is graph traversal only and is reproducible; LLM-augmented mode means a model participated, and the interface says so on the answer.',
  },
  menu: {
    title: 'Staged questions',
    note: 'Each of these has a by-construction answer in the corpus, so the engine can be scored against it rather than believed.',
    why: 'Why this question is here',
    intentLabel: 'Intent',
    empty: 'No staged questions in this corpus.',
  },
  freeText: {
    note: 'Free questions are answered by lexical match onto the entity layer, then by traversal. No model participates, and there is no gold answer to check against.',
  },
  emptyInput: 'Type a question, or press / to pick a staged one.',
} as const;

/** What the user was trying to do. Drives the constellation shape and the copy around it. */
const intents = {
  bridge: {
    label: 'Bridge',
    short: 'Two subjects joined through an entity that appears on both sides.',
    long: 'A bridge question is answered by finding one entity mentioned on two islands and walking through it. The answer path physically crosses a strait, which is why the constellation spans the map instead of clustering.',
  },
  lookup: {
    label: 'Lookup',
    short: 'One hop, one citation.',
    long: 'The floor case. A single high-confidence relation with a quote behind it. The interesting figure is how little the engine had to spend.',
  },
  compare: {
    label: 'Compare',
    short: 'Two subjects against one shared object.',
    long: 'The constellation should be a fork, not a chain: two paths meeting at the thing they have in common.',
  },
  timeline: {
    label: 'Timeline',
    short: 'Ordering carried by the graph, not by a sort in the interface.',
    long: 'The order comes from the structural reading-order and session relations in the corpus. Those relations are exempt from the truth gate on purpose: they describe the artifact, not the world.',
  },
  summarize: {
    label: 'Summarise',
    short: 'A breadth question over one subject.',
    long: 'Breadth questions exhaust the budget fastest. The number worth reading is not what was rendered but what was omitted-but-connected.',
  },
} as const satisfies Record<QueryIntent, TermCopy>;

const modes = {
  deterministic: {
    label: 'Deterministic mode',
    short: 'Graph traversal only. Same question, same answer, every time.',
    long: 'The answer is produced by walking admitted relations and nothing else. No model participates, so the result is reproducible and every hop can be traced to the edge that carried it.',
  },
  llm_augmented: {
    label: 'LLM-augmented mode',
    short: 'A model participated in producing this answer.',
    long: 'A model took part, so the wording is not a pure function of the graph. The citations, the path and the budget are still measured — but the answer text is not reproducible in the way a deterministic render is, and that is disclosed here rather than inferred later.',
  },
} as const satisfies Record<QueryMode, TermCopy>;

/* =============================================================================
 * 5. THE ANSWER
 * ========================================================================== */

const answer = {
  title: 'Answer',
  emptyTitle: 'Nothing rendered yet',
  empty: 'No question has been run against this corpus. The terrain you are looking at is the resting map, not an answer.',
  goldLabel: 'By construction',
  goldTip: 'The known-correct answer for this staged question, held by the corpus itself. Its presence is a disclosure: this question was set up in advance.',
  matchesGold: 'Matches the by-construction answer.',
  divergesFromGold: 'Does not match the by-construction answer.',
  path: {
    title: 'Answer path',
    note: 'One row per hop, in traversal order. Each hop names the relation family that carried it and the passages that evidence it.',
    hop: 'Hop',
    via: 'via',
    strait: 'crosses a strait',
    straitTip: 'This hop leaves one island for another. It is only possible because a bridge entity is mentioned on both.',
    evidence: 'Evidence',
    noEvidence: 'No evidence passage — this hop cannot be cited.',
    empty: 'This answer is a set of hops around one subject rather than a single chain.',
  },
  bridge: {
    label: 'Bridge entity',
    tip: 'The entity mentioned on both islands. Remove it and there is no route between the two sides of this answer.',
  },
  explain: {
    action: { label: 'Explain the path', title: 'Re-derive this path independently and compare it to the receipt' } satisfies ActionCopy,
    title: 'Independent re-derivation',
    note: 'The graph was re-traversed between the answer’s own endpoints, without looking at the receipt. The two are then compared.',
    verdicts: {
      identical: {
        label: 'Identical',
        short: 'The independent traversal reproduced the receipt’s edges exactly.',
        long: 'The path in the receipt and the path found by re-traversing the graph use the same edges. The two halves of the screen agree.',
      },
      'not-a-chain': {
        label: 'Not a chain',
        short: 'This answer is a bundle of hops, not a single route.',
        long: 'A chain visits one more node than it has hops and has exactly two ends. This answer does not, so there is nothing to re-derive end to end. That is a fact about the question, not a failure.',
      },
      'no-admitted-route': {
        label: 'No admitted route',
        short: 'No route exists between these endpoints through admitted relations.',
        long: 'A path may exist through claims the truth gate rejected. Those are never traversed: an answer routed through a rejected claim is not a shorter answer, it is a wrong one.',
      },
      differs: {
        label: 'Disagreement',
        short: 'The receipt and the graph disagree about this answer.',
        long: 'Two panels contradicting each other about the same two nodes is the failure this product cannot afford, so it is raised loudly rather than reconciled quietly.',
      },
    },
  },
  copy: { label: 'Copy answer', title: 'Copy the answer text to the clipboard' } satisfies ActionCopy,
} as const;

/* =============================================================================
 * 6. THE RECEIPT — the render trace
 * -----------------------------------------------------------------------------
 * Every row carries a label a stranger understands AND a tip that says why the
 * number can be trusted. Where a figure is derived, the tip says what it is
 * derived from; where a figure is a stand-in, the tip says so.
 * ========================================================================== */

const receipt = {
  title: 'Render trace',
  subtitle: 'What this answer cost, what it was built from, and what was left out.',
  keyHintLabel: 'Provenance',
  emptyTitle: 'No trace yet',
  empty: 'A trace is produced by a render. Run a question and this panel fills with the receipt for it.',

  /* ---- header --------------------------------------------------------- */
  header: {
    traceId: { label: 'Trace', tip: 'Identifier shared by this receipt and the response it came from.' } satisfies RowCopy,
    queryId: { label: 'Query', tip: 'Identifier of the question that produced this render.' } satisfies RowCopy,
    model: { label: 'Produced by', tip: 'What generated the answer. `deterministic-traversal` means no model participated.' } satisfies RowCopy,
    createdAt: { label: 'Rendered at', tip: 'When the trace was assembled.' } satisfies RowCopy,
    latency: { label: 'Latency', tip: 'Wall-clock milliseconds the user waited, measured by the client around the whole call. A cache hit reports a cache hit’s latency, not a replay of the original.', unit: 'ms' } satisfies RowCopy,
    version: { label: 'Format', tip: 'The trace format is version-locked so a receipt archived today still verifies later.' } satisfies RowCopy,
  },

  /* ---- the budget block ------------------------------------------------ */
  budget: {
    title: 'Token budget',
    note: 'Three numbers and the ratio between them. This is the product’s whole claim, stated as arithmetic you can check against the rows below.',
    rows: {
      token_budget: {
        label: 'Budget',
        tip: 'The ceiling the renderer was given for this question. It binds: admission stops at the node that would cross it.',
        unit: 'tok',
      },
      tokens_rendered: {
        label: 'Rendered',
        tip: 'What the render actually cost, summed from the admission rows below. Add them up — the total is not asserted anywhere.',
        unit: 'tok',
      },
      counterfactual_tokens: {
        label: 'Stuffed context',
        tip: 'What the naive alternative would have cost: every passage of every asset this constellation touches, summed from the corpus’s own per-passage counts. A measured inventory, not an estimate.',
        unit: 'tok',
      },
      savings_pct: {
        label: 'Saved',
        tip: 'One minus rendered over stuffed context. Computed from the two rows above it and nothing else.',
        unit: '%',
      },
    } satisfies Record<string, RowCopy>,
  },

  /* ---- the resolution block -------------------------------------------- */
  resolution: {
    title: 'Resolution spent',
    note: 'How much of each node the renderer paid for. These are lengths of the admission list at each tier, not estimates.',
    rows: {
      lod0_passages: {
        label: 'Verbatim passages',
        tip: 'Passages carried at full resolution. Each one is quoted below and each one is checkable against its source bytes.',
      },
      lod1_context_nodes: {
        label: 'Summarised nodes',
        tip: 'Nodes the renderer spent a summary on rather than their source text.',
      },
      lod2_pointer_nodes: {
        label: 'Pointer nodes',
        tip: 'Nodes admitted as a label and an id only — enough to point at, not enough to quote.',
      },
    } satisfies Record<string, RowCopy>,
  },

  /* ---- render confidence ----------------------------------------------- */
  confidence: {
    title: 'Render confidence',
    L: {
      label: 'Confidence L',
      tip: 'The engine’s own estimate that the view it rendered is sufficient for this question. It is a weighted composite of the four measured signals below, not a verdict on whether the answer is true.',
    } satisfies RowCopy,
    note: 'The decomposition sits next to the gauge rather than behind a click, because a high L over a thin composite is exactly the case worth looking at.',
    weightsLabel: 'weight',
    signals: {
      semantic: {
        label: 'Semantic fit',
        tip: 'Mean admission score of the verbatim passages: how much of the question’s language the quotes actually contain. This build ships no embedding model, so the score is a lexical stand-in and reads low on paraphrase — which is the correct direction for a substitute to err.',
      },
      topology: {
        label: 'Topology',
        tip: 'Share of admitted nodes reachable from the answer path through admitted relations. A well-quoted but disconnected constellation scores low here, and should.',
      },
      temporal: {
        label: 'Temporal',
        tip: 'Share of the temporal claims in this constellation that survived the truth gate.',
      },
      authorial: {
        label: 'Authorial',
        tip: 'Half the verbatim share of the citations, half how many distinct sources they come from. Five quotes from one document is weaker evidence than five quotes from five.',
      },
    } satisfies Record<string, RowCopy>,
    absent: 'no evidence for this signal — it was left out of the weighting rather than scored as zero',
  },

  /* ---- families -------------------------------------------------------- */
  families: {
    title: 'Relation families used',
    note: 'A group-by over the admitted relations in this constellation, by σ-class. Rejected claims are not counted; they never carried the answer.',
    countLabel: 'uses',
    empty: 'No admitted relation joined two nodes of this constellation.',
  },

  /* ---- citations ------------------------------------------------------- */
  citations: {
    title: 'Citations',
    note: 'Every quote the answer rests on, with everything a third party needs to check it without trusting this application.',
    countLabel: 'citations',
    rows: {
      passage: { label: 'Passage', tip: 'The span quoted, and its reading-order index inside its asset.' } satisfies RowCopy,
      asset: { label: 'Asset', tip: 'The authored artifact the span came from — the molecule with the declared boundary.' } satisfies RowCopy,
      source: { label: 'Source', tip: 'The ingested document behind the asset. Its verbatim segment is what the hash covers.' } satisfies RowCopy,
      hash: { label: 'Content hash', tip: 'SHA-256 over the verbatim source bytes of this span. Slice the source at the stated offsets, hash it, and it matches.' } satisfies RowCopy,
      tokens: { label: 'Cost', tip: 'Tokens this citation took out of the budget.', unit: 'tok' } satisfies RowCopy,
      why: { label: 'Admitted because', tip: 'The renderer’s own justification for spending on this quote, in engine terms.' } satisfies RowCopy,
      lod: { label: 'Rendered at', tip: 'The resolution tier this citation was carried at. Citations are normally verbatim.' } satisfies RowCopy,
    },
    open: { label: 'Open the passage', title: 'Descend to this passage and read it in place' } satisfies ActionCopy,
    openSource: { label: 'Show the source bytes', title: 'Open the ingested document and highlight the cited span' } satisfies ActionCopy,
    empty: 'No relation on this answer path carried a quotable passage.',
  },

  /* ---- admissions ------------------------------------------------------ */
  admitted: {
    title: 'Admitted',
    note: 'Every node the renderer spent budget on, what it cost, and why it was let in.',
    rows: {
      node: { label: 'Node', tip: 'The node admitted to the rendered context.' } satisfies RowCopy,
      lod: { label: 'Resolution', tip: 'How much of the node was paid for.' } satisfies RowCopy,
      reason: { label: 'Reason', tip: 'The renderer’s justification, in engine terms.' } satisfies RowCopy,
      tokens: { label: 'Cost', tip: 'Tokens spent on this node.', unit: 'tok' } satisfies RowCopy,
      score: { label: 'Score', tip: 'The admission score that cleared the threshold.' } satisfies RowCopy,
    },
  },

  /* ---- the honesty mechanism ------------------------------------------- */
  omitted: {
    title: 'Omitted but connected',
    /** The single most important sentence in the receipt. */
    note: 'What the renderer reached and chose not to spend on. This is where an answer stops being a claim and starts being a decision you can audit.',
    rows: {
      node: { label: 'Node', tip: 'A node connected to this answer that was not admitted.' } satisfies RowCopy,
      why: { label: 'Left out because', tip: 'Why the renderer declined to spend on it, in engine terms.' } satisfies RowCopy,
      hops: { label: 'Distance', tip: 'Hops from the nearest admitted node. One means it was a single step away.' } satisfies RowCopy,
    },
    inTerrain: 'Everything listed here is drawn latent in the terrain. Omission is a budget decision, not a deletion, and the map shows where it happened.',
    empty: 'Nothing connected to this answer was left out. The constellation is closed.',
  },

  /* ---- cache ----------------------------------------------------------- */
  cache: {
    title: 'Render cache',
    hits: { label: 'Hits', tip: 'Repeat resolutions of a node during this one render.' } satisfies RowCopy,
    lookups: { label: 'Lookups', tip: 'Node resolutions attempted during this render.' } satisfies RowCopy,
    rate: { label: 'Hit rate', tip: 'Hits over lookups. This is the engine’s own memo for one render — not the client’s response cache in the top bar. The two count different work and must not be read as one number.', unit: '%' } satisfies RowCopy,
  },

  /* ---- export ---------------------------------------------------------- */
  export: {
    action: { label: 'Copy trace', title: 'Copy the signed trace as JSON' } satisfies ActionCopy,
    note: 'The trace is designed to be checked outside this application. That is the entire point of signing it.',
    copied: 'Copied.',
  },
} as const;

/* =============================================================================
 * 7. TRUST — verification, signature, resolution disclosure
 * ========================================================================== */

const trust = {
  signature: {
    title: 'Signature',
    note: 'A detached Ed25519 signature over the payload hash. The receipt can be verified by anyone holding the signer’s key, including someone who does not trust this application.',
    /**
     * The worthless-key disclosure, in the deployed UI.
     *
     * It previously existed only in the source and the README, so a visitor to the
     * published demo could read a green VALID badge and a `did:web:` signer without
     * ever being told the key is printed in the source and authenticates nothing.
     * The product's own first principle is that the interface never lies about the
     * engine; a signature panel that omits this was the sharpest live counter-example.
     */
    demoKey:
      'This demo signs with a fixed key whose private half is printed in its source, under a DID in the reserved .example domain that can never resolve. It proves the bytes have not moved. It proves nothing about who produced them, and it is not the engine’s identity.',
    rows: {
      payloadHash: { label: 'Payload hash', tip: 'SHA-256 over the canonicalised trace: the answer, the citations and the admissions. This is the thing the signature signs.' } satisfies RowCopy,
      alg: { label: 'Algorithm', tip: 'The signature scheme. Fixed for this build.' } satisfies RowCopy,
      did: { label: 'Signer', tip: 'A demo identifier in the reserved .example domain — it cannot be registered and resolves to nothing. A real deployment resolves did:web:<host> to a published key; this one deliberately cannot.' } satisfies RowCopy,
      keyId: { label: 'Key', tip: 'Which key of the signer’s identifier was used, so keys can rotate without invalidating archived traces. This demo’s key is public and authenticates nothing.' } satisfies RowCopy,
      sig: { label: 'Signature', tip: 'The detached signature bytes. Copy it and verify it elsewhere.' } satisfies RowCopy,
    },
  },

  verify: {
    action: { label: 'Verify', title: 'Recompute the payload hash and check the signature, locally' } satisfies ActionCopy,
    note: 'Verification runs locally, even against a live engine. You do not ask the party that produced a receipt whether the receipt is good.',
    checkedAt: { label: 'Checked', tip: 'When this verification was performed.' } satisfies RowCopy,
    halves: {
      payload: { label: 'Payload hash', tip: 'The hash recomputed over the trace payload equals the hash recorded in it.' } satisfies RowCopy,
      signature: { label: 'Signature', tip: 'The recorded signature verifies against the signer’s key.' } satisfies RowCopy,
    },
    /** Both halves are reported separately on purpose: the pair is the diagnosis. */
    separately: 'Both halves are checked and reported separately. Which one failed tells you what was touched.',
    valid: {
      badge: 'verified',
      title: 'Signature valid, payload intact',
      body: 'The payload hash was recomputed from the trace and matches the signed value, and the signature verifies against the signer’s key. Nothing in this receipt has moved since it was rendered.',
    },
    invalidPayload: {
      badge: 'payload moved',
      title: 'The payload no longer matches its signed hash',
      body: 'The signature still verifies, so the header was not touched — but the bytes underneath it are not the bytes that were signed. Something in the answer, the citations or the admissions was edited after the fact.',
    },
    invalidSignature: {
      badge: 'signature broken',
      title: 'The signature does not verify',
      body: 'The payload hash still matches the payload, so the content is intact — but the signature or the signer’s identifier was altered. This receipt cannot be attributed to the engine that claims to have produced it.',
    },
    unchecked: {
      badge: 'unverified',
      title: 'Not yet verified',
      body: 'Nothing has been checked. Press Verify to recompute the hash and test the signature.',
    },
  },

  tamper: {
    title: 'Break it on purpose',
    note: 'These controls mutate the real trace bytes and re-run this demo’s own verifier. Nothing here is simulated — that is why it is worth doing.',
    kinds: {
      payload: { label: 'Alter a quote', title: 'Rewrite a digit inside the first citation and re-verify' } satisfies ActionCopy,
      signature: { label: 'Alter the signature', title: 'Flip a byte of the detached signature and re-verify' } satisfies ActionCopy,
      did: { label: 'Alter the signer', title: 'Change the signing identifier and re-verify' } satisfies ActionCopy,
    },
    tampered: 'This trace has been deliberately altered. It is no longer the receipt the engine produced.',
    restore: { label: 'Restore', title: 'Fetch the original trace again and re-verify' } satisfies ActionCopy,
  },

  /* -----------------------------------------------------------------------
   * RESOLUTION DISCLOSURE
   * ---------------------------------------------------------------------
   * How to say "this quote is resolved, not verbatim" without sounding like a
   * disclaimer. The framing is: the system states this about EVERY quote,
   * including the clean ones. A label that only appears when something is wrong
   * reads as an admission; a label that is always present reads as a method.
   * -------------------------------------------------------------------- */
  disclosure: {
    title: 'Resolution disclosure',
    note: 'Every quote states how far it has travelled from the bytes on disk — including the ones that have not travelled at all.',
    why: 'A citation that was silently rewritten is the failure this whole schema exists to prevent. So the distance from the source is a property of the quote, printed with it, always.',
    openSource: { label: 'Read the original', title: 'Open the source document at the cited span' } satisfies ActionCopy,
    levels: {
      verbatim: {
        label: 'verbatim',
        short: 'Byte-identical to the source.',
        long: 'This span is exactly what the document says. The hash is computed over these bytes; slice the source at the stated offsets and it matches.',
      },
      coref_resolved: {
        label: 'coreference resolved',
        short: 'Pronouns replaced with what they refer to.',
        long: 'The engine substituted named referents for pronouns so the span reads standalone. The document makes the same claim in different words. The character offsets still recover the original bytes, and the hash is still computed over those.',
      },
      term_resolved: {
        label: 'terms resolved',
        short: 'Abbreviations and aliases normalised to canonical names.',
        long: 'Surface forms were replaced with the canonical name of the entity they resolve to, so the span can be read without the document’s local shorthand. The claim is unchanged; the wording is not the document’s. The hash still covers the original bytes.',
      },
    } satisfies Record<PassageResolution, TermCopy>,
  },

  hash: {
    label: 'Content hash',
    tip: 'SHA-256 over verbatim source bytes — never over a summary, a normalisation or a re-serialisation. Click to copy the full value.',
    copied: 'Hash copied.',
    prefixNote: 'Displayed truncated so it can be compared by eye. The full value is on the clipboard.',
  },

  sourceSegment: {
    label: 'Source segment',
    tip: 'Segment 0 of a source is its verbatim text and is the only layer a citation may rest on. Higher segments are derived layers — normalisations, corrections — and may not satisfy a citation.',
    verbatimBadge: 'segment 0 · verbatim',
    derivedBadge: 'derived layer',
  },
} as const;

/* =============================================================================
 * 8. THE TRUTH GATE — quarantine and integrity
 * ========================================================================== */

const quarantine = {
  title: 'Quarantine',
  subtitle: 'Claims the truth gate rejected. They are still in the graph.',
  note: 'Rejected claims ship in the payload and render latent. Hiding them would make the pass rate look better and the terrain look emptier than it is.',
  never: 'A quarantined relation is never traversed and never carries an answer.',
  show: { label: 'Show rejected claims', title: 'Stroke quarantined relations in the terrain' } satisfies ActionCopy,
  hide: { label: 'Hide rejected claims', title: 'Stop stroking quarantined relations' } satisfies ActionCopy,
  countLabel: 'quarantined',
  empty: 'The gate rejected nothing in this view.',

  gate: {
    title: 'The gate',
    rule: 'A truth-gated relation is admitted when its extraction confidence clears the floor and it carries at least one evidence passage. Everything else is quarantined with a named reason.',
    floor: { label: 'Confidence floor', tip: 'The admission threshold. An edge below it is quarantined as confidence_below_floor, and the integrity report can be checked against the edge list rather than believed.' } satisfies RowCopy,
    exemption: 'Structural relations are exempt. They describe the artifact, not the world — “this passage came after that one” is a fact about the file, and there is nothing about it to verify. Gating them would quarantine the graph’s own skeleton.',
  },

  /** The seven rejection codes, in human language. Machine code always shown alongside. */
  reasons: {
    span_not_in_source: {
      label: 'Span not in the source',
      short: 'The quoted offsets do not resolve inside the cited document.',
      long: 'The extractor claimed a character range that is not there. Whatever the claim says, it cannot be checked against the bytes it points at, so it is not admitted.',
    },
    entity_not_grounded: {
      label: 'Endpoint not grounded',
      short: 'One end of the relation could not be reconciled to a known entity.',
      long: 'A relation needs two entities. This one has a dangling end — a name the reconciler could not resolve — so traversing it would walk into nothing.',
    },
    inverse_conflict: {
      label: 'Contradicted by a stronger claim',
      short: 'A higher-confidence relation asserts the inverse of this one.',
      long: 'Two claims disagree about direction and one is better evidenced. The weaker one is held rather than deleted, so the disagreement stays visible.',
    },
    temporal_paradox: {
      label: 'Temporal paradox',
      short: 'The asserted ordering contradicts the declared boundary dates.',
      long: 'The claim puts an event before something it must have followed. The dates come from the documents’ own declared boundaries, so the claim is the thing that gives way.',
    },
    confidence_below_floor: {
      label: 'Below the confidence floor',
      short: 'Extraction confidence did not clear the admission threshold.',
      long: 'The extractor was not sure enough. The number and the floor are both on the record, so this rejection can be recomputed rather than taken on faith.',
    },
    duplicate_assertion_divergent_object: {
      label: 'Duplicate with a different object',
      short: 'The same subject and family were asserted twice with different objects.',
      long: 'One of the two is wrong and the gate cannot tell which. Admitting either would let a traversal reach a confident answer down an arbitrary path.',
    },
    source_hash_mismatch: {
      label: 'Source hash mismatch',
      short: 'The hash on file differs from the hash of the bytes cited.',
      long: 'The document changed after extraction, or the citation points at a different document than it claims. Either way every claim resting on those bytes is stale.',
    },
  } satisfies Record<QuarantineReason, TermCopy>,
} as const;

const integrity = {
  title: 'Integrity',
  subtitle: 'The truth gate’s own report card.',
  note: 'An engine that only reports its successes is not an instrument, it is an advertisement.',
  rows: {
    total_edges: { label: 'Relations extracted', tip: 'Every relation the extractor produced, admitted or not.' } satisfies RowCopy,
    admitted: { label: 'Admitted', tip: 'Relations that passed the gate and may carry an answer.' } satisfies RowCopy,
    quarantined: { label: 'Quarantined', tip: 'Relations the gate rejected. Still present in the graph, rendered latent.' } satisfies RowCopy,
    rate: { label: 'Rejection rate', tip: 'Quarantined over truth-gated. Structural relations are excluded from the denominator because they were never gated.', unit: '%' } satisfies RowCopy,
    truth_gate_exempt_structural: {
      label: 'Exempt (structural)',
      tip: 'Structural relations that were never gated. Reported separately and explicitly, so the exemption is visible instead of quietly inflating the pass rate.',
    } satisfies RowCopy,
  },
  byReason: { title: 'By reason', note: 'Grouped by the gate’s own code, most common first. Every group opens onto the relations it rejected.' },
  examples: { label: 'Examples', action: { label: 'Show these', title: 'Select the example relations in the terrain' } satisfies ActionCopy },
} as const;

/* =============================================================================
 * 9. THE RESOLUTION RAMP
 * -----------------------------------------------------------------------------
 * The legend for the five-state visual state machine. This is the engine's
 * rendering decision made visible, so the legend explains a DECISION, not a
 * styling preference.
 * ========================================================================== */

const ramp = {
  title: 'Resolution',
  subtitle: 'Five tiers. Every node on screen is at exactly one of them, and the tier is the engine’s spending decision.',
  note: 'Resolution is not zoom. A node stays latent at maximum magnification if the engine did not spend on it, and a node the answer rests on stays verbatim when you zoom away.',
  places: {
    fovea: 'fovea',
    penumbra: 'penumbra',
    periphery: 'periphery',
  },
  states: {
    'lod-0': {
      label: 'Verbatim',
      short: 'Fovea. Read to you in full, byte for byte.',
      long: 'The passage is carried at full resolution and carries the provenance guarantee: its hash is over the source bytes and its resolution is disclosed. This is the only tier a citation may rest on.',
    },
    'lod-1': {
      label: 'Summary',
      short: 'Penumbra. The engine spent a summary, not the source.',
      long: 'Enough of the node to reason with, at a fraction of the cost. A summary is never quotable — cite the passage underneath it, not this.',
    },
    'lod-2': {
      label: 'Label',
      short: 'Periphery. Label and id only.',
      long: 'Enough to point at and enough to navigate to, not enough to quote. Pointer nodes are how the render keeps the topology intact without paying for it.',
    },
    ghost: {
      label: 'Ghost',
      short: 'Present, not spent on. Label on hover only.',
      long: 'The node is in the terrain and in the payload; the renderer simply did not spend on it. Its label appears when you point at it, and nowhere else, because a label storm is a way of showing nothing.',
    },
    latent: {
      label: 'Latent',
      short: 'Outline only. Known to exist, resolved to nothing.',
      long: 'Latent is load-bearing. It exists so the terrain never has holes: content the engine omitted is still there as topology, in its real position, at its real size. Omission is a budget decision, not a deletion — and you can see exactly where it happened.',
    },
  } satisfies Record<LodState, TermCopy>,
} as const;

/* =============================================================================
 * 10. σ-CLASSES AND RELATION FAMILIES
 * ========================================================================== */

const sigma = {
  title: 'σ-class',
  subtitle: 'What kind of claim a relation makes.',
  note: 'Every relation belongs to exactly one class. The class decides its colour, whether it bundles, and whether it has to pass the truth gate.',
  gatedLabel: 'truth-gated',
  exemptLabel: 'exempt',
  classes: {
    factual: {
      label: 'Factual',
      short: 'The state of the world: composition, ownership, identity, role.',
      long: 'Who owns what, what is part of what, what something is. The largest class, and the one most answers are carried by.',
    },
    temporal: {
      label: 'Temporal',
      short: 'When, in what order, and for how long.',
      long: 'Ordering, validity windows and supersession. Anchored against each document’s declared boundary date rather than against ingest time.',
    },
    causal: {
      label: 'Causal',
      short: 'Because, enables, prevents, depends on.',
      long: 'The claims that are hardest to extract and easiest to over-read. They are gated like everything else, and their rejections are worth reading.',
    },
    episodic: {
      label: 'Episodic',
      short: 'Discrete events that happened to somebody.',
      long: 'Acquisitions, filings, commissionings, participations. Dated events with a subject, as opposed to standing facts.',
    },
    authorial: {
      label: 'Authorial',
      short: 'Who said it, and where it came from.',
      long: 'Authorship, citation, derivation, quotation. This is the class the evidence light is drawn from: it is the graph talking about its own provenance.',
    },
    structural: {
      label: 'Structural',
      short: 'The document’s own skeleton: reading order and co-document links.',
      long: 'Underscore-prefixed relations that describe the artifact rather than the world. They are exempt from the truth gate because there is nothing about them to verify, and gating them would disconnect the terrain into dust.',
    },
  } satisfies Record<SigmaClass, TermCopy>,
  family: {
    label: 'Relation family',
    tip: 'The typed token on a relation — `operates`, `acquired`, `_follows`. Families come in inverse pairs where a reversal is meaningful, so a traversal reads forwards in either direction.',
    inverse: 'inverse',
    noInverse: 'no meaningful inverse',
  },
} as const;

/* =============================================================================
 * 11. THE FOUR RUNGS
 * ========================================================================== */

const rungs = {
  title: 'The spine',
  note: 'Exactly four rungs. There is no rung above continent, and verbatim evidence is not a rung — it lives inside a passage as its source segment.',
  entityNote: 'Entities are not a rung. They are the cross-cutting layer above the spine, and they are what make an answer able to cross a strait.',
  levels: {
    continent: {
      label: 'Continent',
      plural: 'Continents',
      short: 'A top-level semantic region.',
      long: 'The coarsest grouping of islands, washed in its community hue so you can tell where you are from maximum zoom-out without reading a single label.',
      descend: 'Descend into an island',
      contains: 'islands',
    },
    island: {
      label: 'Island',
      plural: 'Islands',
      short: 'A coherent cluster of documents inside a continent.',
      long: 'Islands are what straits run between. A relation that leaves an island is the visual event this whole terrain is built around.',
      descend: 'Descend into a document',
      contains: 'assets',
    },
    asset: {
      label: 'Asset',
      plural: 'Assets',
      short: 'One authored artifact with a declared boundary.',
      long: 'The molecule: a contract, a paper, a thread, a merged change, a chapter, a dated session. Somebody, at some point, said “this is one thing”. It is the unit of resolution and the context extraction happens inside.',
      descend: 'Descend into a passage',
      contains: 'passages',
    },
    passage: {
      label: 'Passage',
      plural: 'Passages',
      short: 'A verbatim span inside a document.',
      long: 'The provenance floor. A passage carries the character offsets into its source, the hash over those bytes, and the disclosure of how far its rendered text has travelled from them.',
      descend: 'Read the source bytes',
      contains: 'mentions',
    },
  } satisfies Record<Rung, {
    label: string; plural: string; short: string; long: string; descend: string; contains: string;
  }>,
  kinds: {
    continent: 'continent',
    island: 'island',
    asset: 'asset',
    passage: 'passage',
    entity: 'entity',
    source: 'source',
  } satisfies Record<NodeKind, string>,
  boundary: {
    label: 'Declared boundary',
    tip: 'What kind of artifact this is, and therefore what made it one thing. If you cannot name the boundary, you do not have a document — you have a pile of text.',
    kinds: {
      contract: 'contract',
      paper: 'paper',
      thread: 'thread',
      pr: 'change request',
      chapter: 'chapter',
      session: 'session',
    } satisfies Record<BoundaryKind, string>,
    declaredAt: { label: 'Boundary declared', tip: 'When the boundary was declared — the execution date, the submission, the merge, the session date. Not the ingest time. Temporal claims are anchored against this.' } satisfies RowCopy,
  },
  strait: {
    label: 'Strait',
    /* The counted form. The island ledger prints this beside a figure — `6
       STRAITS` — next to `24 ASSETS` and `103 PASSAGES`, and it was the one
       column of the three that read `6 STRAIT`. An instrument that claims its
       arithmetic is exact does not get to be careless about the noun. */
    plural: 'Straits',
    tip: 'A relation whose two ends sit on different islands. Straits are only crossable through bridge entities, and crossing one is what a bridge question is for.',
  },
  tradeRoute: {
    label: 'Trade route',
    tip: 'A bundled corridor of relations between two regions, drawn instead of the individual relations. The corridor’s own count is the truth about how many it carries; the relations shipped with it are a sample.',
  },
} as const;

/* =============================================================================
 * 12. ATLAS MODE
 * ========================================================================== */

const atlas = {
  title: 'Atlas Mode',
  subtitle: 'All four rungs at once.',
  note: 'The same world at four resolutions, side by side. Descending is not loading a new page — it is spending more resolution on a smaller area of the same map.',
  captions: {
    continent: 'The world as regions. No labels are needed to tell them apart: the hue is the region, and it survives a re-bake.',
    island: 'Clusters inside a region, and the corridors between them. What crosses between two islands is a strait.',
    asset: 'Documents with declared boundaries, and the entities extracted inside them. This is where the entity layer becomes visible in place.',
    passage: 'Spans inside one document, in reading order, with the mentions that fall inside them. Below this there is only the source bytes.',
  } satisfies Record<Rung, string>,
  descend: { label: 'Descend', title: 'Spend more resolution on this node' } satisfies ActionCopy,
  ascend: { label: 'Ascend', title: 'Return to the containing rung' } satisfies ActionCopy,
  here: 'you are here',
} as const;

/* =============================================================================
 * 13. INSPECTOR
 * ========================================================================== */

const inspector = {
  title: 'Inspector',
  emptyTitle: 'Nothing selected',
  empty: 'Point at the terrain to preview a node; click to hold it here.',
  rows: {
    id: { label: 'Id', tip: 'Stable identifier. It survives a re-bake and is never reused for new content.' } satisfies RowCopy,
    kind: { label: 'Kind', tip: 'What this node is. Entities and sources are real nodes that are not rungs.' } satisfies RowCopy,
    community: { label: 'Community', tip: 'The cluster this node belongs to. Its hue is a stable hash of this id, so the colour survives a re-layout.' } satisfies RowCopy,
    centrality: { label: 'Centrality', tip: 'Normalised importance within the current view. It drives the node’s radius.' } satisfies RowCopy,
    degree: { label: 'Degree', tip: 'Relations touching this node, both directions, structural included.' } satisfies RowCopy,
    lod: { label: 'Resolution', tip: 'The tier this node is currently admitted at.' } satisfies RowCopy,
    tokens: { label: 'Tokens', tip: 'Total tokens across this document’s passages. The denominator of a render budget.', unit: 'tok' } satisfies RowCopy,
    mentions: { label: 'Mentions', tip: 'Passages where this entity is named. They are the evidence that it exists.' } satisfies RowCopy,
    islands: { label: 'Islands', tip: 'Islands with at least one mentioning document. More than one makes this a bridge entity.' } satisfies RowCopy,
    aliases: { label: 'Aliases', tip: 'Surface forms that resolve to this entity. They are what term-resolved passages normalise away.' } satisfies RowCopy,
    entityType: { label: 'Type', tip: 'Coarse type assigned by extraction.' } satisfies RowCopy,
    seq: { label: 'Reading order', tip: 'Index of this span inside its document. It is what the structural reading-order relations are built from.' } satisfies RowCopy,
    span: { label: 'Span', tip: 'Character offsets into the source’s verbatim segment. Slice the source at these offsets and you get this passage back.' } satisfies RowCopy,
    locator: { label: 'Locator', tip: 'The original filename, URI or message id as ingested.' } satisfies RowCopy,
    mediaType: { label: 'Media type', tip: 'What kind of artifact was ingested.' } satisfies RowCopy,
    ingestedAt: { label: 'Ingested', tip: 'When the document entered the system. Not when it was authored.' } satisfies RowCopy,
    summary: { label: 'Summary', tip: 'Engine-generated. Never cite this — cite the passage underneath it.' } satisfies RowCopy,
  },
  entityTypes: {
    organization: 'organization',
    facility: 'facility',
    person: 'person',
    site: 'site',
    material: 'material',
    technology: 'technology',
    regulation: 'regulation',
    market_instrument: 'market instrument',
    period: 'period',
  } as const,
  bridgeBadge: 'bridge entity',
  bridgeTip: 'Mentioned on more than one island. Paths that cross a strait route through entities like this one.',
  actions: {
    focus: { label: 'Focus', title: 'Centre the camera on this node' } satisfies ActionCopy,
    descend: { label: 'Descend', title: 'Open the rung below this node' } satisfies ActionCopy,
    neighbours: { label: 'Neighbourhood', title: 'Draw the relations one hop from this node' } satisfies ActionCopy,
    ask: { label: 'Ask about this', title: 'Stage a question about this node in the command bar' } satisfies ActionCopy,
  },
} as const;

/* =============================================================================
 * 14. ANALYST MODE
 * ========================================================================== */

const analyst = {
  title: 'Analyst Mode',
  subtitle: 'The controls that change what is drawn, and the readouts that say what happened.',
  note: 'Every filter here narrows what is stroked. None of them changes the payload: what is filtered out is still in the terrain, and still counted in the readouts.',
  sigmaFilter: {
    title: 'Relation classes',
    note: 'Which σ-classes may be stroked. Turning one off does not remove its relations from the graph.',
    all: { label: 'All', title: 'Stroke every class' } satisfies ActionCopy,
    none: { label: 'None', title: 'Stroke no class' } satisfies ActionCopy,
  },
  familyFilter: {
    title: 'Relation families',
    note: 'Restrict to specific families. Empty means no restriction.',
    placeholder: 'Filter families',
    empty: 'No family matches that.',
  },
  edgePolicy: {
    title: 'Edge policy',
    note: 'The terrain never draws every relation. It draws one of three legible subsets and always says which.',
    reasons: {
      'trade-route-skeleton': {
        label: 'Trade routes',
        short: 'The high-weight corridors that define the terrain.',
        long: 'At the region rungs this is the only thing drawn: bundled corridors between regions, with a sample of the real relations behind each. The corridor’s own count is the truth about how many it carries.',
      },
      'hover-neighborhood': {
        label: 'Hover neighbourhood',
        short: 'The relations around whatever you are pointing at.',
        long: 'The k-hop neighbourhood of the pointer target, intersected with what is on screen. Rejected claims never extend a neighbourhood.',
      },
      'query-constellation': {
        label: 'Answer constellation',
        short: 'Exactly the relations on and adjacent to the answer path.',
        long: 'With an answer on screen this is the only honest set. Everything else drops to ghost so the path is readable as a path.',
      },
    } satisfies Record<DrawnReason, TermCopy>,
  },
  readouts: {
    nodes: { label: 'Nodes', tip: 'Nodes in the payload, including the ones drawn latent.' } satisfies RowCopy,
    edges: { label: 'Relations', tip: 'Relations in the payload, including the ones the gate rejected.' } satisfies RowCopy,
    drawn: { label: 'Stroked', tip: 'Relations the renderer actually strokes this frame. Always fewer than the payload carries, and the difference is deliberate.' } satisfies RowCopy,
    withheld: { label: 'Withheld', tip: 'In the payload and not stroked. A picture of everything is a picture of nothing; this is the number that says how much legibility cost.' } satisfies RowCopy,
    labels: { label: 'Labels', tip: 'Labels placed this frame, against labels that could have been. Label density is a budget like any other.' } satisfies RowCopy,
    bundles: { label: 'Corridors', tip: 'Bundled routes drawn at this rung, and the relations they carry between them.' } satisfies RowCopy,
  },
  perf: {
    title: 'Frame',
    fps: { label: 'FPS', tip: 'Measured frames per second over the last second of rendering.' } satisfies RowCopy,
    frameMs: { label: 'Frame', tip: 'Measured milliseconds spent producing the last frame.', unit: 'ms' } satisfies RowCopy,
    points: { label: 'Points', tip: 'Node instances submitted this frame.' } satisfies RowCopy,
    drawCalls: { label: 'Draw calls', tip: 'Draw calls issued this frame.' } satisfies RowCopy,
  },
  density: {
    title: 'Density',
    note: 'Spacing and hit targets only. Density never changes a colour and never changes a meaning.',
    modes: {
      comfortable: { label: 'Comfortable', short: 'Default spacing.', long: 'The resting layout: room around every control, built for a desk.' },
      compact: { label: 'Compact', short: 'Tighter rows, same targets.', long: 'For long sessions and small screens. Rows tighten; nothing is removed and nothing is renamed.' },
      touch: { label: 'Touch', short: 'Larger hit targets.', long: 'Targets grow to a size a finger can hit, without magnifying the type or changing a single readout.' },
    } satisfies Record<DensityMode, TermCopy>,
  },
  reducedMotion: {
    label: 'Reduced motion',
    tip: 'Follows the system setting. Camera moves become cuts and transitions collapse; nothing is hidden and no readout changes.',
  },
} as const;

/* =============================================================================
 * 15. TIMELINE
 * ========================================================================== */

const timeline = {
  title: 'Timeline',
  subtitle: 'The corpus’s own clock.',
  note: 'Two kinds of event, and they are not the same thing: a document declaring its boundary, and a relation making a dated claim.',
  window: { label: 'Window', tip: 'The span shown. It defaults to the corpus’s earliest and latest declared boundary — never to a sentinel date, because a placeholder in an instrument cannot be told from a measurement.' } satisfies RowCopy,
  scope: { label: 'Scope', tip: 'The region or document the window is taken over. Scope walks down the spine, so a continent admits everything beneath it.', all: 'the whole world' },
  events: {
    boundary: { label: 'Boundary declared', tip: 'A document declaring itself one thing, on the date it did so.' } satisfies RowCopy,
    claim: { label: 'Dated claim', tip: 'A temporal or episodic relation, at the instant it asserts.' } satisfies RowCopy,
  },
  truncated: { label: 'Not shown', tip: 'Events inside the window that the limit cut off. Reported rather than silently dropped.' } satisfies RowCopy,
  includeQuarantined: { label: 'Include rejected claims', title: 'Show dated claims the truth gate rejected, drawn latent' } satisfies ActionCopy,
  empty: 'No dated events in this window.',
  loading: 'Timeline not loaded.',
} as const;

/* =============================================================================
 * 16. COMMAND SEARCH
 * ========================================================================== */

const search = {
  title: 'Command search',
  placeholder: 'Search nodes, questions and commands',
  groups: {
    questions: 'Staged questions',
    nodes: 'On the map',
    commands: 'Commands',
    rungs: 'Rungs',
  },
  empty: 'Nothing matches that. Search is over labels and aliases in the current bake.',
  hint: 'Enter to run · Esc to close',
} as const;

/* =============================================================================
 * 17. HELP AND THE KEYBOARD
 * ========================================================================== */

const help = {
  title: 'How to read this',
  subtitle: product.thesis,
  sections: {
    reading: {
      title: 'Reading the terrain',
      body: 'Hue is region and it never changes: the same cluster keeps its colour across a re-layout, so “the orange island” stays true. Brightness is resolution — how much the engine spent on a node. Cyan is the engine’s attention, amber is old light from the sources, violet marks what is not known.',
    },
    lights: {
      title: 'The lights',
      render: 'Cyan — the engine’s attention. Selection, the active path, the fovea. If the engine is not attending to it, it is not cyan.',
      evidence: 'Amber — old light. Citations, hashes, signatures, verbatim spans. Everything whose authority predates this session.',
      curiosity: 'Violet — the question light. Gaps, unresolved references, what was connected and omitted.',
      alarm: 'Red — fail-loud only. If the interface shows red, something is actually wrong and it will say what and what to do.',
    },
    trust: {
      title: 'Why you can check it',
      body: 'Every quote carries the hash of the source bytes it came from and states how far it has travelled from them. Every render produces a signed trace covering the answer, the citations and the admissions. Verification runs locally, and the receipt is built to be checked outside this application entirely.',
    },
    limits: {
      title: 'What this build does not do',
      body: 'The corpus is generated. There is no embedding model in this build, so semantic fit is measured lexically and reads low on paraphrase. Free-text questions are matched against entity labels and aliases, not meaning. Where a figure is a stand-in, the row that shows it says so.',
    },
  },
  glossary: { title: 'Glossary', note: 'The words this product uses, and what they mean here. Terms are used consistently: nothing in the interface is called two things.' },
  close: { label: 'Close', title: 'Close this overlay' } satisfies ActionCopy,
} as const;

const keyboard = {
  title: 'Keyboard',
  note: 'Eleven bindings, three groups, every one of them a verb the product performs.',
  groups: {
    navigate: 'Navigate',
    panels: 'Panels',
    query: 'Query',
  } satisfies Record<KeyGroup, string>,
  /** Per action. Imperative, lowercase-first, no period — matches the map in state/keys. */
  actions: {
    'rung-continent': 'jump to the continent rung',
    'rung-island': 'jump to the island rung',
    'rung-asset': 'jump to the asset rung',
    'rung-passage': 'jump to the passage rung',
    ascend: 'ascend one rung',
    'clear-focus': 'clear focus and selection',
    atlas: 'Atlas Mode — all four rungs at once',
    inspector: 'Inspector',
    receipt: 'Provenance — the render trace',
    timeline: 'Timeline',
    analyst: 'Analyst Mode',
    help: 'this list, and the glossary',
    search: 'command search',
    'run-query': 'render the staged question',
  } satisfies Record<KeyActionId, string>,
} as const;

/* =============================================================================
 * 18. THE LIFECYCLE STATES
 * -----------------------------------------------------------------------------
 * Every screen is designed for all of them. There is no "and then it just works"
 * state, and none of these is a blank page.
 * ========================================================================== */

const states = {
  /* --- FIRST-RUN: the void, one latent constellation, one control. ------- */
  'FIRST-RUN': {
    title: product.name,
    /** Line one: what this is. */
    body: 'A knowledge terrain: one corpus, four rungs, and an engine that renders the shortest sufficient view of it rather than retrieving a pile of passages.',
    /** Line two: what will happen. Named work, no numbers. */
    note: 'Opening the corpus ingests the archive, bakes one layout, and leaves you on the map with a question staged and unrun.',
    action: { label: 'Open the corpus', title: 'Ingest the bundled corpus and bake the layout' } satisfies ActionCopy,
  } satisfies StateCopy,

  /* --- EMPTY: never a blank page. This is where the ramp is explained. --- */
  EMPTY: {
    title: 'No corpus loaded',
    body: 'The grid behind this panel is drawn at latent resolution: outline only, no labels, nothing spent. It is what the terrain looks like when the engine knows something is there and has not been asked to resolve it.',
    note: 'Latent is a real tier of the resolution ramp, not a placeholder. It is the reason the terrain never has holes: content the engine omits is still present as topology, in its real position. Nothing here is pretending to be data — it is the shape of an unresolved world.',
    action: { label: 'Ingest the corpus', title: 'Ingest the bundled corpus and bake the layout' } satisfies ActionCopy,
  } satisfies StateCopy,

  INGESTING: {
    title: 'Ingesting',
    body: 'Documents are landing. Each one is hashed over its verbatim bytes, split into passages at real character offsets, and joined to the entity layer as it arrives.',
    note: 'Nothing on this screen is a progress animation. What moves is what has actually arrived.',
  } satisfies StateCopy,

  SETTLING: {
    title: 'Settling',
    body: 'The layout is baking. Positions are being aligned to the previous bake by a rigid transform over shared anchors, so the map you remember stays the map you get.',
    note: 'Anchor drift is reported when it settles. A high value means spatial memory really did break, and the interface will say so rather than pretend the map is unchanged.',
  } satisfies StateCopy,

  READY: {
    title: 'Ready',
    body: 'The resting map. A question is staged and has not been run.',
  } satisfies StateCopy,

  QUERYING: {
    title: 'Rendering',
    body: 'The terrain dims while the constellation assembles. Nothing is being hidden: everything off the answer path drops to ghost, and comes back when the render lands.',
  } satisfies StateCopy,

  DEGRADED: {
    title: 'Degraded',
    body: 'Something failed. The failure and its remedy are stated in the bar above, in the engine’s own words.',
  } satisfies StateCopy,
} as const satisfies Record<AppState, StateCopy>;

/* =============================================================================
 * 19. DEGRADED — the alarm bar
 * -----------------------------------------------------------------------------
 * The engine supplies `what_failed` and `exact_remedy` on every error it raises;
 * this deck supplies the human headline and the framing around them. It does NOT
 * restate the engine's two lines, because a second copy of a sentence is a second
 * copy that can drift.
 * ========================================================================== */

const degraded = {
  banner: 'Degraded',
  codeLabel: 'Code',
  whatFailedLabel: 'What failed',
  remedyLabel: 'Remedy',
  /** Why the two lines below are worded the way they are. Shown in the help overlay. */
  note: 'The failure and the remedy come from the engine, not from this interface. A component that cannot state the remedy has not finished diagnosing the failure.',
  recover: { label: 'Recover', title: 'Return to the last good state' } satisfies ActionCopy,
  dismiss: { label: 'Dismiss', title: 'Hide this bar and stay in the degraded state' } satisfies ActionCopy,

  /** The real set, from the codes the engine and the shell actually raise. */
  byCode: {
    QUERY_NO_MATCH: {
      title: 'Nothing on this map matches that question',
      meaning: 'No entity label or alias in the current bake contains any of the question’s terms. The engine refused to answer rather than produce a confident paragraph with nothing underneath it.',
    },
    QUERY_NO_EVIDENCE: {
      title: 'Reached the graph, found nothing citable',
      meaning: 'The question landed on real nodes, but no admitted relation between them carried a quotable passage. An answer without a citation is not an answer this engine will return.',
    },
    NOT_FOUND: {
      title: 'That id is not in this bake',
      meaning: 'Ids belong to the bake that minted them. A stale link or an old panel is holding an id this layout does not contain.',
    },
    BAD_RUNG: {
      title: 'That is not one of the four rungs',
      meaning: 'The spine has exactly four: continent, island, asset, passage. There is no rung above continent and evidence is not a rung.',
    },
    BAD_DRAWN_REASON: {
      title: 'That is not one of the three edge rules',
      meaning: 'Relations are earned, never all-on. The policy lives in the engine seam precisely so a caller cannot opt out of it.',
    },
    BAD_REQUEST: {
      title: 'The engine was called with something missing',
      meaning: 'A required parameter was absent or empty. The engine rejected the call rather than guessing what was meant.',
    },
    NO_SUCH_ROUTE: {
      title: 'The engine has no such route',
      meaning: 'A path was constructed by hand instead of through a client method, and the engine does not serve it.',
    },
    TRANSPORT_FAILED: {
      title: 'The engine could not be reached',
      meaning: 'The request never completed. Nothing was left half-applied: state advances only on a response.',
    },
    MALFORMED_RESPONSE: {
      title: 'The reply was not JSON',
      meaning: 'Something answered at that address, but not with an engine envelope. A proxy or a sign-in page is the usual cause.',
    },
    ENGINE_REJECTED: {
      title: 'The engine rejected the request',
      meaning: 'The call reached a live engine and came back as an error status. The engine’s own log for this request is the next place to look.',
    },
    REQUEST_ABORTED: {
      title: 'The request was cancelled',
      meaning: 'It was abandoned before it completed — usually because a newer action superseded it. Nothing was left in a partial state.',
    },
    NO_FETCH: {
      title: 'This runtime cannot make requests',
      meaning: 'A live engine is configured but there is no fetch implementation available to talk to it.',
    },
    ENGINE_UNCAUGHT: {
      title: 'An unmapped failure reached the surface',
      meaning: 'Something threw without a code, a cause and a remedy. That is itself a defect: every failure that leaves the engine is supposed to carry all three.',
    },
    PATH_DISAGREEMENT: {
      title: 'The receipt and the graph disagree',
      meaning: 'Re-traversing the graph between this answer’s own endpoints produced a different chain than the receipt records. Two panels contradicting each other about the same two nodes is raised loudly rather than reconciled quietly.',
    },
    WEBGL_UNAVAILABLE: {
      title: 'This display cannot draw the terrain',
      meaning: 'No WebGL2 context could be created, so there is no terrain to render. The panels still work; the map does not.',
    },
    SAVED_VIEW_CORRUPT: {
      title: 'That shared view did not survive the trip',
      meaning: 'The link decoded to something that is not a scene. Shared views are usually truncated by whatever carried them.',
    },
  } satisfies Record<string, FailureCopy>,

  /** Anything the deck has not met yet. Never a shrug: the engine still supplies both lines. */
  unknown: {
    title: 'A failure this interface does not have a name for',
    meaning: 'The engine still carries what failed and what to do about it; only the headline is missing here.',
  } satisfies FailureCopy,
} as const;

/* =============================================================================
 * 20. THE TERRAIN HUD
 * ========================================================================== */

const hud = {
  drawnReasonLabel: 'Drawing',
  /* ---------------------------------------------------------------------------
   * THE DRAW COUNT AND THE PAYLOAD COUNT, EACH UNDER ITS OWN NOUN.
   *
   * The HUD once printed `STROKED 254 / 262` while the renderer had laid down 38
   * strokes, because `edges_drawn` is the payload minus what the gate rejected —
   * a payload figure, under a word that means DRAWN. These two rows exist so the
   * two quantities can never again share a label.
   * ------------------------------------------------------------------------ */
  strokes: {
    label: 'Stroked',
    tip: 'Lines the renderer laid down on this frame, counted by the renderer itself. At a corridor rung it is far smaller than the relation count: relations bundle into corridors, and only the highest-traffic corridors survive the rung’s edge budget. With an answer on screen it is slightly larger, because each hop of the path is drawn a second time as a road over its own relation. A count of strokes — never a count of relations.',
  } satisfies RowCopy,
  relations: {
    label: 'Relations',
    tip: 'Relations in the payload: what the truth gate admitted, over everything shipped. This is what the engine sent, not what the renderer drew — the two are routinely an order of magnitude apart and are printed here as two figures for exactly that reason.',
  } satisfies RowCopy,
  /** The sentence the payload can write about itself. Numbers come from the view stats. */
  withheldNote: 'In the payload, not stroked. Legibility is a policy here, not a rendering limit.',
  corridorsNote: 'Corridors carry their own totals; the relations shipped with them are exemplars, not the corridor’s truth.',
  latentNote: 'Latent nodes are drawn in their real positions. Nothing on this map is missing — some of it is unresolved.',
  fogNote: 'Dimmed while a render is in flight.',
  emptyRung: 'Nothing at this rung under the current scope.',
  hoverHint: 'Point to preview · click to select · double-click to descend',
  selectionLabel: 'Selected',
  clearSelection: { label: 'Clear', title: 'Clear the selection and the focus' } satisfies ActionCopy,
} as const;

/* =============================================================================
 * 21. SAVED VIEW
 * ========================================================================== */

const savedView = {
  title: 'Share this view',
  note: 'The link carries the rung, the scope, the camera, the selection and the panel layout. It does not carry the corpus — it reconstructs the scene against the same bake.',
  action: { label: 'Copy link', title: 'Copy a link that reconstructs this exact view' } satisfies ActionCopy,
  copied: 'Link copied.',
  restored: 'View restored from a shared link.',
  bakeMismatch: 'This link was made against a different bake. The scene has been reconstructed as closely as the current layout allows.',
} as const;

/* =============================================================================
 * 22. SHARED WORDING
 * ========================================================================== */

const common = {
  close: { label: 'Close', title: 'Close this panel' } satisfies ActionCopy,
  copy: { label: 'Copy', title: 'Copy to the clipboard' } satisfies ActionCopy,
  copied: 'Copied.',
  more: 'Show more',
  less: 'Show less',
  none: 'none',
  unknown: 'unknown',
  notRun: 'not run',
  notLoaded: 'not loaded',
  ofLabel: 'of',
  showAll: 'Show all',
  dismiss: 'Dismiss',
  units: {
    tokens: 'tok',
    ms: 'ms',
    percent: '%',
    ratio: '×',
    hops: 'hops',
    layout: 'u',
  },
  /** Labels for the mono primitive's own affordances. */
  measured: 'measured',
  derived: 'derived',
  standIn: 'stand-in',
  standInTip: 'This figure substitutes for one this build cannot measure. The row says which, and in which direction it errs.',
} as const;

/* =============================================================================
 * 23. ACCESSIBLE NAMES
 * -----------------------------------------------------------------------------
 * The canvas has no DOM to read, so its accessible name has to carry what a
 * sighted reader gets from the picture. These are names, not descriptions.
 * ========================================================================== */

const a11y = {
  terrain: 'Knowledge terrain. Use the rung keys to move between resolutions and the command bar to render a question.',
  terrainBusy: 'Knowledge terrain, rendering a question.',
  commandBar: 'Question, staged and not yet rendered',
  receiptPanel: 'Render trace for the current answer',
  degradedBar: 'Failure and remedy',
  skipToCommand: 'Skip to the command bar',
} as const;

/* =============================================================================
 * THE DECK
 * ========================================================================== */

/**
 * THE WALKTHROUGH — seven steps that teach the thesis by operating the product.
 *
 * Not a slideshow and not a tour of features. Each step is a thing the engine
 * actually does, in the order that makes "render, don't retrieve" land: you see
 * the map, you notice nothing has been spent, you spend it, you read what it
 * cost, you check the receipt yourself, then you change altitude.
 *
 * Step 3 is the hinge. Everything before it is setup; the moment the user runs
 * the query themselves is the moment the claim stops being a slogan.
 */
const walkthrough = {
  open: { label: 'Show me around', title: 'Seven steps through what this does' },
  resume: { label: 'Walkthrough', title: 'Run the walkthrough again' },
  skip: 'Skip',
  next: 'Next',
  back: 'Back',
  done: 'Done',
  ofLabel: 'of',
  steps: [
    {
      id: 'terrain',
      title: 'This is one corpus, laid out by meaning',
      body: 'Every point is a real thing in the archive. Position is not decorative — it is a baked projection of meaning, so neighbours here are neighbours in the corpus. Colour is region. Most of the map is dim because nothing has been asked yet.',
    },
    {
      id: 'staged',
      title: 'The question is staged, not run',
      body: 'It sits in the command bar unanswered. The engine has not spent a single token on it. Nothing you are looking at was retrieved — this is the whole corpus at rest.',
    },
    {
      id: 'render',
      title: 'Now spend the budget',
      body: 'Running it is your act, and that is the point. Watch what lights up: the engine renders the shortest sufficient view instead of stuffing everything it can reach into a context window.',
    },
    {
      id: 'receipt',
      title: 'What it cost, and what it did not',
      // Deliberately quotes NO figures. The receipt panel is open beside this
      // card showing the real ones, and prose that restates a derived number is
      // a lie waiting for the next corpus change — which is exactly how this
      // line broke the first time.
      body: 'The panel on the right is the receipt. It shows what stuffing the whole neighbourhood into a context window would have cost, against what the engine actually spent. The difference is not a smaller answer — it is the same answer without the padding, and the receipt names every node admitted and the resolution it was admitted at.',
    },
    {
      id: 'path',
      title: 'The answer crosses a strait',
      body: 'The two hops run through a bridge entity mentioned on two different islands. That crossing is real geography on this map, not a metaphor — you can see the path leave one land mass and arrive at another.',
    },
    {
      id: 'verify',
      title: 'You do not have to take its word',
      body: 'The trace is signed, and verification runs locally — you never ask the party that issued a receipt whether the receipt is good. Break it on purpose and the failure names which half broke: the payload or the signature.',
    },
    {
      id: 'rungs',
      title: 'Zoom changes what things are',
      body: 'Four rungs: continent, island, asset, passage. Descending is not magnification — at each level the map is made of different objects, and the bottom rung is the verbatim source text with its hash.',
    },
  ],
} as const;

export const COPY = {
  walkthrough,
  product,
  provenance,
  topbar,
  command,
  intents,
  modes,
  answer,
  receipt,
  trust,
  quarantine,
  integrity,
  ramp,
  sigma,
  rungs,
  atlas,
  inspector,
  analyst,
  timeline,
  search,
  help,
  keyboard,
  states,
  degraded,
  hud,
  savedView,
  common,
  a11y,
} as const;

/** The type of the whole deck. Downstream may narrow into it; nothing may widen it. */
export type Copy = typeof COPY;
