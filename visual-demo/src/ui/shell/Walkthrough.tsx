/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE TASK TOURS
 * =============================================================================
 *
 * Five moves of the product, performed BY THE READER, plus two three-step tours
 * for the two lenses worth a separate pass.
 *
 * -----------------------------------------------------------------------------
 * WHAT THE OLD WALKTHROUGH TAUGHT, AND WHAT IT LEFT BEHIND
 * -----------------------------------------------------------------------------
 * Seven steps — terrain / staged / render / receipt / path / verify / rungs — of
 * which exactly ONE (`render`) asked the user to do anything; the other six
 * narrated while the tour operated the product itself. It never taught selecting
 * a node, opening more than the first source of a hop, coming back from a
 * drill-down, or reading the map by date, because none of those were steps.
 *
 * And it did not clean up after itself. Steps 2, 4 and 7 drove
 * `toggle('inspector')`, `toggle('receipt')` and `toggle('atlas')` and reverted
 * NONE of them, so pressing Done handed back a workspace with three surfaces
 * stacked that the user had never opened and could not account for. The last
 * thing an onboarding does is set the state everything afterwards is judged
 * against; this one set a mess.
 *
 * -----------------------------------------------------------------------------
 * THE THREE RULES THIS FILE LIVES BY
 * -----------------------------------------------------------------------------
 * 1. EVERY STEP DRIVES THE REAL STORE. `runQuery`, `openPassage`,
 *    `returnToResult`, `setLens`, `applyTimelineWindow` — the same actions a
 *    click drives. There is no scripted playback, no fake cursor, no mocked
 *    panel. If the engine were broken the tour would break with it, loudly. A
 *    tour that plays a recording of a product working is exactly the kind of lie
 *    this codebase exists to argue against, and it would be the easiest lie to
 *    tell here.
 *
 * 2. THE READER ACTS; THE CARD CHECKS. Each step names a task and then reads the
 *    REAL STORE to find out whether it happened — `query.active !== null`,
 *    `rung === 'passage'`, `timelineApplied`. Nothing sets a "completed" flag.
 *    The "do it for me" control is a fallback for someone who would rather
 *    watch, and it runs the same action their own click would have.
 *
 * 3. IT PUTS THE WORKSPACE BACK. Every exit runs `finish()`: back to Explore,
 *    back to the scene the answer was framed in, timeline window released, the
 *    tab pin dropped, the staged question taken back, every stray panel closed.
 *    See that function for what "clean" means precisely. EVERY exit — Finish,
 *    Skip and Escape are one door, because two of the three used to be a bare
 *    `setOpen(false)` and the rule above was written without a qualifier.
 *
 * IT IS STILL NOT MODAL. The card docks bottom-centre above the HUD, the terrain
 * stays live behind it, and the user can pan, hover and click at any time
 * without dismissing anything — which is the only way rule 2 can work at all.
 *
 * IT STILL DOES NOT NAG. Seen-state persists to localStorage, so it runs once,
 * and it is re-runnable for ever after from the help dialog.
 * =============================================================================
 */

import { useCallback, useEffect, useState } from 'react';

import { COPY } from '@/copy';
import type { GuidanceStep, GuidanceTour } from '@/copy/blocks/guidance';
import { useAtlas, useAtlasStore } from '@/state';
import type { AtlasState, UiPanel } from '@/state';
import { Btn, Num } from '@/ui/primitives';

import './help.css';

const SEEN_KEY = 'tldrg.visual-demo.walkthrough.seen';

/**
 * Set once anything has explicitly closed the walkthrough this session.
 *
 * It exists because of a genuine race: the scene driver dismisses the coach as
 * part of its baseline, and only THEN does the corpus finish ingesting and the
 * app reach READY — at which point the auto-open effect would fire and put the
 * card back over the screenshot. Storage alone cannot settle this, because the
 * dismissal and the auto-open are racing within one mount.
 */
let suppressed = false;

/*
 * The suppression listener is registered AT MODULE SCOPE, not in the component.
 *
 * This is the whole bug it was written for: on load the app is in FIRST-RUN,
 * where the shell returns early and never mounts <Walkthrough/>. A close event
 * dispatched then — which is exactly when the scene driver's baseline sends one —
 * arrived with no listener attached, so the flag stayed false, and the coach
 * opened over the first screenshot the moment the corpus reached READY.
 *
 * A gate that only works while the thing it gates is on screen is not a gate.
 */
if (typeof window !== 'undefined') {
  window.addEventListener('atlas:walkthrough-close', () => {
    suppressed = true;
  });
  window.addEventListener('atlas:walkthrough', () => {
    suppressed = false;
  });
}

/** Has this browser already been walked through? Storage can throw under privacy modes. */
function seen(): boolean {
  try {
    return window.localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

function markSeen(): void {
  try {
    window.localStorage.setItem(SEEN_KEY, '1');
  } catch {
    /* A browser that refuses storage gets the walkthrough again. That is the
       harmless failure direction; silently skipping it is not. */
  }
}

/* -----------------------------------------------------------------------------
 * DEV-TIME SELF-CHECK — the guidance block names controls it does not own
 * -----------------------------------------------------------------------------
 * The tour's key GLYPHS are read from `KEYMAP`, so it can never name a shortcut
 * nobody wired. Its button LABELS were free prose, and four of them said
 * `Return to result` for a control whose only rendering reads `Back to result`.
 *
 * `copy/blocks/guidance.ts` cannot import the deck to fix that at the source —
 * `deck.ts` imports IT, so the cycle would leave `COPY` undefined while the
 * block evaluates. This is the same contract enforced from the other end: every
 * deck label the block quotes verbatim has to still be findable in the block's
 * own prose. Re-word a control and this fires naming the file to edit.
 *
 * It is a substring test over the flattened block rather than a per-string
 * assertion because the same label is quoted in a topic body, a step body, a
 * task line and an act label, and a check that had to be told where to look is a
 * check that goes stale in the same commit as the copy.
 * -------------------------------------------------------------------------- */
const __DEV__ = Boolean((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV);

if (__DEV__) {
  const prose: string[] = [];
  const flatten = (v: unknown): void => {
    if (typeof v === 'string') prose.push(v);
    else if (Array.isArray(v)) v.forEach(flatten);
    else if (v !== null && typeof v === 'object') Object.values(v).forEach(flatten);
  };
  flatten(COPY.guidance);
  const all = prose.join('\n');

  const quoted: ReadonlyArray<readonly [string, string]> = [
    ['COPY.nav.toResult.label', COPY.nav.toResult.label],
    ['COPY.nav.home.label', COPY.nav.home.label],
    ['COPY.evidence.read.label', COPY.evidence.read.label],
    ['COPY.evidence.locate.label', COPY.evidence.locate.label],
    ['COPY.timelineLens.scope.label', COPY.timelineLens.scope.label],
    ['COPY.timelineLens.scope.options.answer.label', COPY.timelineLens.scope.options.answer.label],
    ['COPY.timelineLens.scope.options.corpus.label', COPY.timelineLens.scope.options.corpus.label],
    ['COPY.timelineLens.apply.label', COPY.timelineLens.apply.label],
    ['COPY.timelineLens.reset.label', COPY.timelineLens.reset.label],
  ];
  const missing = quoted
    .filter(([, label]) => !all.includes(label))
    .map(([path, label]) => `${path} — "${label}"`);
  if (missing.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      '[ui/shell/Walkthrough] copy/blocks/guidance.ts no longer names these controls by the label the deck ships:\n' +
        missing.join('\n'),
    );
  }
}

/* =============================================================================
 * THE TOURS
 * ========================================================================== */

type TourId = 'main' | 'timeline' | 'analyze';

/**
 * The three tours, typed down from the copy block's const literal.
 *
 * The annotation is load-bearing rather than decorative: `as const` gives each
 * step its own exact shape, so `steps[i].act` would be a property access on a
 * union where half the members have no `act` at all. Naming the interface once
 * here is what lets the card read a step generically.
 */
const TOURS: Record<TourId, GuidanceTour> = {
  main: COPY.guidance.tours.main,
  timeline: COPY.guidance.tours.timeline,
  analyze: COPY.guidance.tours.analyze,
};

/**
 * What a step DOES, and how it knows whether the reader did it.
 *
 * `enter`  the real work of arriving at the step — navigation, never the task.
 * `act`    performs the step's own task through the real action. Optional: a
 *          step whose task is "read this" has nothing to perform.
 * `done`   a pure read of the real store. Absent means the step has nothing
 *          checkable, and the card then shows the task without a completion
 *          state rather than inventing one.
 */
interface StepRuntime {
  enter?: () => void | Promise<void>;
  act?: () => void | Promise<void>;
  done?: (s: AtlasState) => boolean;
}

/**
 * The question step 1 put in the command bar, if it put one there.
 *
 * IT IS TRACKED BECAUSE THE TOUR HAS TO TAKE IT BACK. Step 1 stages a question
 * before the reader has agreed to anything, and every exit that does not run it
 * used to leave it sitting in the bar — a question the reader never typed, in
 * the control the whole product is asked through. `finish()` clears it, and only
 * it: if the reader ran it, or typed over it, the text in the bar is theirs.
 */
let stagedByTour: string | null = null;

/**
 * Was there anywhere to come back FROM when step 4 opened?
 *
 * Not a completion flag — the predicate below is still a pure read of the real
 * store. This is an ARRIVAL latch, and it exists because the store cannot tell
 * "came back" from "never left" after the fact, and because step 4's `enter` is
 * async: without it the card renders `done: true` for the length of one network
 * call and the reader sees "Done" flash over a task they have not done.
 */
let returnArmed = false;

/**
 * The state this step ARRIVED in — the thing a completion is measured against.
 *
 * WITHOUT IT, A LATER STEP'S ARRIVAL COMPLETES AN EARLIER STEP'S TASK. Every
 * `done` below was an absolute read of the store, which is right for "has a
 * question been rendered" and wrong for "have you tried a different workspace":
 * step 4's `enter` drives `openPassage` for a reader who did not drill down
 * themselves, which leaves `rung: 'passage'` — and that made step 3 report Done
 * for a task the TOUR performed, and step 5 report Done on arrival for a task
 * the reader had not been offered yet. A tick nobody earned is worse than no
 * tick: it is the coach agreeing that something happened.
 *
 * So a step whose task is A CHANGE compares against this. A step whose task has
 * an absolute answer ("a result exists", "the window is applied") still reads the
 * store directly, because for those the baseline would be noise.
 */
let stepBaseline: { lens: string; rung: string; stackDepth: number; focus: string | null } = {
  lens: 'explore',
  rung: 'island',
  stackDepth: 0,
  focus: null,
};

/** Called by `goTo` AFTER the step's own arrival work, so it captures the truth. */
function captureBaseline(): void {
  const s = useAtlas.getState();
  stepBaseline = {
    lens: s.lens,
    rung: s.rung,
    stackDepth: s.stack.length,
    focus: s.focus,
  };
}

const RUNTIME: Record<string, StepRuntime | undefined> = {
  /* ---- the five moves ------------------------------------------------- */
  'main:ask': {
    enter: () => {
      const s = useAtlas.getState();
      void s.setLens('explore');
      stagedByTour = null;
      /* Stage a question only if the bar is empty. Overwriting one the reader
         typed would be the tour deciding what they came to ask. */
      if (s.query.staged.trim().length === 0) {
        const first = s.stagedQueries[0];
        if (first !== undefined) {
          s.stageQuery(first.query);
          stagedByTour = first.query;
        }
      }
    },
    act: async () => {
      const s = useAtlas.getState();
      if (s.query.staged.trim().length > 0) await s.runQuery(s.query.staged);
    },
    done: (s) => s.query.active !== null,
  },

  'main:read': {
    /* No `enter`. A render lands on Evidence by design, and moving the reader to
       Answer here would be the tour performing the one thing this step exists to
       ask them to do. */
    act: () => useAtlas.getState().setTab('answer', { pin: true }),
    done: (s) => s.tab === 'answer',
  },

  'main:open': {
    /* This IS navigation, not the task: the sources have to be on screen before
       "press Read source on any quote" means anything. The task is choosing one
       and opening it, which is left alone. */
    enter: () => useAtlas.getState().setTab('evidence'),
    act: async () => {
      const s = useAtlas.getState();
      const first = s.trace?.citations[0];
      if (first !== undefined) await s.openPassage(first.passage_id);
    },
    /* MEASURED AGAINST ARRIVAL, NOT ABSOLUTELY. Step 4's `enter` drives
       `openPassage` for a reader who skipped this one, so an absolute
       `rung === 'passage'` reported Done here the moment they stepped BACK — a
       completion for a task the tour had performed on their behalf, over a
       control the card had already hidden because it thought the job was done. */
    done: (s) =>
      s.rung === 'passage' &&
      s.focus !== null &&
      !(stepBaseline.rung === 'passage' && stepBaseline.focus === s.focus),
  },

  'main:return': {
    /**
     * ARRIVING HERE MEANS BEING SOMEWHERE ELSE, and it did not.
     *
     * Step 3's task is optional and its `act` is a fallback, so Next-Next-Next
     * is the common path — and it arrived here at `rung: 'island'`, `stack: 0`
     * against a `resultScene` of `island` / `0`. The predicate below was
     * therefore already true on arrival, the card printed "Done" over "Press
     * Back to result", and line 457 hid the control because `done === true`.
     * A completion the reader had not earned, reported over a task they could
     * not perform.
     *
     * This is the same argument step 3's `enter` makes one rung shallower — the
     * sources have to be on screen before "press Read source" means anything,
     * and the reader has to be off the answer's scene before "press Back to
     * result" does. It is `enter`, not the task: the step's own sentence already
     * asserts "you are several moves from where the answer was framed", and the
     * only two ways to make that sentence true are to navigate or to delete it.
     * It runs the identical action step 3's own fallback drives, and only for a
     * reader who did not drill down themselves.
     */
    enter: async () => {
      returnArmed = false;
      const s = useAtlas.getState();
      const scene = s.resultScene;
      if (scene !== null && s.rung === scene.rung && s.stack.length === scene.stack.length) {
        const first = s.trace?.citations[0];
        if (first !== undefined) await s.openPassage(first.passage_id);
      }
      returnArmed = true;
    },
    act: async () => {
      await useAtlas.getState().returnToResult();
    },
    done: (s) => {
      /* Dormant until arrival has finished, or the async `enter` above would be
         raced by a card that has already declared the trip over. */
      if (!returnArmed) return false;
      /* With no result there is nowhere to return to, so the step is vacuously
         satisfied — as it is for a result with no citation to open, which is the
         same "nowhere to go" in a different shape. The alternative — an unticked
         task whose control does nothing — is a dead affordance, and this
         codebase deletes those. */
      const scene = s.resultScene;
      if (scene === null) return true;
      return s.rung === scene.rung && s.stack.length === scene.stack.length;
    },
  },

  'main:widen': {
    /* Deliberately no `act`. The step is an invitation, and a tour that presses
       the optional button for you has made it not optional. */
    /* THE TASK IS A CHANGE, SO THE TEST IS A COMPARISON. Absolutely, this read
       true on arrival for any reader who came from step 4 without returning —
       the previous step's own arrival work had left them on the passage rung, so
       the tour ticked an invitation it had not yet made. */
    done: (s) => s.lens !== stepBaseline.lens || s.rung !== stepBaseline.rung,
  },

  /* ---- the timeline lens ---------------------------------------------- */
  'timeline:enter': {
    act: async () => {
      await useAtlas.getState().setLens('timeline');
    },
    done: (s) => s.lens === 'timeline',
  },
  'timeline:scope': {
    enter: async () => {
      await useAtlas.getState().setLens('timeline');
    },
  },
  'timeline:window': {
    enter: async () => {
      await useAtlas.getState().setLens('timeline');
    },
    act: () => {
      /* The middle half of the axis, then a real commit. Two actions, both the
         ones the handles and the button drive — brushing previews, applying
         holds, and the reader can watch the difference land. */
      const s = useAtlas.getState();
      s.setTimelineWindow({ a: 0.25, b: 0.75 });
      s.applyTimelineWindow();
    },
    done: (s) => s.timelineApplied,
  },

  /* ---- the analyze lens ------------------------------------------------ */
  'analyze:enter': {
    act: async () => {
      await useAtlas.getState().setLens('analyze');
    },
    done: (s) => s.lens === 'analyze',
  },
  'analyze:filters': {
    enter: async () => {
      await useAtlas.getState().setLens('analyze');
    },
    /* No `done`: the task is "turn one off, then on again", which ends where it
       started. A completion test over a state the task restores would flicker
       green and then go out, which reads as the tour losing track of you. */
  },
  'analyze:leave': {
    act: async () => {
      await useAtlas.getState().setLens('explore');
    },
    done: (s) => s.lens === 'explore',
  },
};

/**
 * Put the workspace back where a finished tour should leave it.
 *
 * THE OLD TOUR'S LAST ACT WAS TO LEAVE THREE PANELS OPEN. This is the opposite
 * contract, and "clean" is defined here rather than described:
 *
 *   - the Explore lens, which is the resting one and the only one that is a home
 *   - the scene the answer was framed in, so the reader ends looking at their
 *     own result rather than at whatever the last step navigated to
 *   - no timeline window held: a selection the reader did not make is the
 *     workspace misreporting what they did
 *   - no stray panel. `timeline` and `analyst` are NOT in that list — they are
 *     lenses, `setLens` above owns them, and toggling them here would fight it.
 *
 * The final tab follows the store's own rule for a resting workspace — Evidence
 * when there is a result to have evidence for, Answer when there is not. That
 * rule already lives in `home()` and `clearFocus()`; restating it differently
 * here would be a third opinion about the same question.
 *
 * AND IT HAS TO COPY THE WHOLE RULE, WHICH IT DID NOT. `setTab(tab)` with no
 * opts resolves `tabPinned: opts.pin ?? s.tabPinned`, so the pin survived — and
 * this tour pins the tab itself twice over: `main:read`'s fallback is
 * `setTab('answer', { pin: true })`, and `openPassage` commits `tabPinned: true`
 * on its own. `home()` and `clearFocus()` both release it in the same breath as
 * they set the tab, so the ordinary path — press "Open Answer" on step 2, press
 * Finish — handed back a pinned workspace, and a re-run of the same question
 * then stayed off the evidence surface it would otherwise have landed on. The
 * pin is a thing the reader did not ask for, which is the definition of what
 * this function exists to take back.
 */
async function finish(): Promise<void> {
  const start = useAtlas.getState();
  if (start.timelineApplied || start.timelineWindow !== null) start.resetTimelineWindow();

  await useAtlas.getState().setLens('explore');

  const afterLens = useAtlas.getState();
  if (afterLens.resultScene !== null) await afterLens.returnToResult();

  /* `inspector` IS ON THIS LIST BECAUSE THE TOUR OPENS IT. `openPassage`
     commits `ui: { ...s.ui, inspector: true }`, and two of this tour's own
     fallbacks drive it — so the zero-action path handed the reader back a rail
     panel they never opened, which is precisely the unaccounted-for workspace
     this function exists to prevent. `timeline` and `analyst` are deliberately
     absent: `toggle()` routes those to `setLens`, and flipping a lens here would
     move the reader rather than tidy up after the tour. */
  const stray: UiPanel[] = ['receipt', 'atlas', 'search', 'quarantine', 'inspector'];
  for (const key of stray) {
    if (useAtlas.getState().ui[key]) useAtlas.getState().toggle(key);
  }

  /* Take back the question step 1 staged, and only that one. Two ways it stops
     being the tour's to take: the reader typed over it (`staged` has moved), or
     they RAN it — and `runQuery` leaves the text in the bar, so the test is
     against the active result's own verbatim question rather than against
     "is there a result", which would strand the staged text behind any older
     answer. A bar the reader never typed into is not a resting workspace; a bar
     that names the answer on screen is. */
  if (stagedByTour !== null) {
    const bar = useAtlas.getState();
    const asked = bar.query.active?.query ?? null;
    if (bar.query.staged === stagedByTour && asked !== stagedByTour) bar.stageQuery('');
    stagedByTour = null;
  }

  const end = useAtlas.getState();
  end.setTab(end.query.active === null ? 'answer' : 'evidence', { pin: false });
}

/* =============================================================================
 * THE CARD
 * ========================================================================== */

export interface WalkthroughProps {
  className?: string;
}

export function Walkthrough({ className }: WalkthroughProps): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [tourId, setTourId] = useState<TourId>('main');
  const [i, setI] = useState(0);
  const [busy, setBusy] = useState(false);

  const tour = TOURS[tourId];
  const step: GuidanceStep | undefined = tour.steps[i];
  const runtime = step === undefined ? undefined : RUNTIME[`${tour.id}:${step.id}`];

  /**
   * The app state, and whether this step's task has actually landed.
   *
   * Both come out of one shallow-compared selector, so the card repaints when
   * the reader completes the task and at no other time — a pointer moving over
   * the terrain does not repaint a coach card.
   */
  const { app, done } = useAtlasStore((s) => ({
    app: s.app,
    done: runtime?.done === undefined ? null : runtime.done(s),
  }));

  /**
   * THE ONE EXIT. Skip, Escape and Finish are the same door.
   *
   * They were not. Skip was a bare `setOpen(false)` and so was the Escape
   * handler; only Finish ran `finish()`. Rule 3 in this file's header states the
   * contract without a qualifier — "IT PUTS THE WORKSPACE BACK" — and two of the
   * three exits did none of it, on a tour whose fallbacks genuinely move the
   * workspace: `main:open` and `main:return` drive `openPassage` (passage rung,
   * three deep, Inspect tab pinned, inspector opened), `timeline:enter` changes
   * the lens, `timeline:window` holds a real window. A reader who pressed one
   * "do it for me" and then Skip was handed back exactly the unaccounted-for
   * workspace this module exists to prevent.
   *
   * It is declared HERE rather than beside the buttons because the Escape effect
   * below needs it and effects cannot live after the card's early return.
   * `dismissWalkthrough()` is deliberately NOT routed through it — see the note
   * on that export: a teardown before a screenshot is not a completion.
   */
  const closeTour = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      await finish();
    } finally {
      setBusy(false);
      setOpen(false);
    }
  }, []);

  /** Move to a step of a tour, and do that step's real arrival work. */
  const goTo = useCallback(async (id: TourId, next: number) => {
    const target = TOURS[id];
    if (next < 0 || next >= target.steps.length) return;
    setTourId(id);
    setI(next);
    const enter = RUNTIME[`${id}:${target.steps[next].id}`]?.enter;
    if (enter === undefined) {
      captureBaseline();
      return;
    }
    setBusy(true);
    try {
      await enter();
    } finally {
      /* AFTER the arrival work, so the baseline is where the reader actually
         starts this step rather than where the previous one left them. */
      captureBaseline();
      setBusy(false);
    }
  }, []);

  // Offer it once, and only once the corpus is actually on screen. Opening over
  // FIRST-RUN or SETTLING would be coaching someone through a map that is not
  // there yet.
  useEffect(() => {
    if (app !== 'READY' || suppressed || seen()) return;
    markSeen();
    setOpen(true);
    void goTo('main', 0);
  }, [app, goTo]);

  // Re-entry from the help dialog. A custom event rather than more store
  // surface: the tour is chrome, not application state, and nothing else needs
  // to be able to read whether it is open.
  useEffect(() => {
    const onStart = (): void => {
      suppressed = false;
      setOpen(true);
      void goTo('main', 0);
    };
    const onStop = (): void => {
      suppressed = true;
      setOpen(false);
    };
    window.addEventListener('atlas:walkthrough', onStart);
    window.addEventListener('atlas:walkthrough-close', onStop);
    return () => {
      window.removeEventListener('atlas:walkthrough', onStart);
      window.removeEventListener('atlas:walkthrough-close', onStop);
    };
  }, [goTo]);

  // While the tour is up it IS the explanation of the map, so the rung legend
  // stands down rather than competing with it in the same strip. A data
  // attribute rather than new store surface: this is chrome coordination, and
  // `ui` should not grow a key that only CSS reads.
  useEffect(() => {
    const root = document.documentElement;
    if (open) root.dataset.walkthrough = '1';
    else delete root.dataset.walkthrough;
    return () => {
      delete root.dataset.walkthrough;
    };
  }, [open]);

  // Esc closes, like every other dismissible surface here — through the same
  // door Skip and Finish use, because an exit that skips `finish()` is an exit
  // that leaves the workspace somewhere the reader did not put it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') void closeTour();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, closeTour]);

  if (!open || step === undefined || app === 'FIRST-RUN' || app === 'EMPTY') return null;

  const last = i === tour.steps.length - 1;
  const offerTours = last && tour.id === 'main';

  const perform = async (): Promise<void> => {
    if (runtime?.act === undefined) return;
    setBusy(true);
    try {
      await runtime.act();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={['walk', className].filter(Boolean).join(' ')}
      role="region"
      aria-label={COPY.guidance.tours.regionLabel}
    >
      <div className="walk__hd">
        <span className="walk__count">
          <Num value={i + 1} format="int" /> {COPY.walkthrough.ofLabel}{' '}
          <Num value={tour.steps.length} format="int" />
        </span>
        <Btn variant="ghost" size="sm" onClick={() => void closeTour()} disabled={busy}>
          {COPY.walkthrough.skip}
        </Btn>
      </div>

      <h2 className="walk__title">{step.title}</h2>
      <p className="walk__prose" data-prose>
        {step.body}
      </p>

      {/* THE IMPERATIVE, AND WHETHER IT LANDED. `data-done` is read off the real
          store by the selector above — nothing here records its own progress. */}
      <p className="walk__do" data-done={done === true ? 'true' : undefined}>
        <span className="walk__doLabel caps">
          {done === true ? COPY.guidance.tours.doneLabel : COPY.guidance.tours.taskLabel}
        </span>
        <span className="walk__doText" data-prose>
          {step.task}
        </span>
      </p>

      {step.act === undefined || done === true ? null : (
        <div className="walk__act">
          <Btn
            variant="quiet"
            size="sm"
            onClick={() => void perform()}
            disabled={busy}
            title={step.act.title}
          >
            {step.act.label}
          </Btn>
        </div>
      )}

      {!offerTours ? null : (
        <div className="walk__tours">
          <span className="walk__toursPrompt">{COPY.guidance.tours.prompt}</span>
          <div className="walk__toursRow">
            <Btn
              variant="quiet"
              size="sm"
              onClick={() => void goTo('timeline', 0)}
              disabled={busy}
              title={TOURS.timeline.title}
            >
              {TOURS.timeline.label}
            </Btn>
            <Btn
              variant="quiet"
              size="sm"
              onClick={() => void goTo('analyze', 0)}
              disabled={busy}
              title={TOURS.analyze.title}
            >
              {TOURS.analyze.label}
            </Btn>
          </div>
        </div>
      )}

      <div className="walk__ft">
        {/* A rail of ticks rather than a progress bar: a bar implies work being
            done, and nothing is loading here. */}
        <div className="walk__ticks" aria-hidden="true">
          {tour.steps.map((s, n) => (
            <span key={s.id} className={n <= i ? 'walk__tick walk__tick--on' : 'walk__tick'} />
          ))}
        </div>
        <div className="walk__acts">
          {i > 0 ? (
            <Btn
              variant="quiet"
              size="sm"
              onClick={() => void goTo(tourId, i - 1)}
              disabled={busy}
            >
              {COPY.walkthrough.back}
            </Btn>
          ) : null}
          {last ? (
            <Btn
              variant="primary"
              size="sm"
              onClick={() => void closeTour()}
              disabled={busy}
              title={COPY.guidance.tours.finish.title}
            >
              {COPY.guidance.tours.finish.label}
            </Btn>
          ) : (
            <Btn
              variant="primary"
              size="sm"
              onClick={() => void goTo(tourId, i + 1)}
              disabled={busy}
            >
              {COPY.walkthrough.next}
            </Btn>
          )}
        </div>
      </div>
    </div>
  );
}

/** Re-run the tour from the top. Called by the help dialog. */
export function startWalkthrough(): void {
  window.dispatchEvent(new Event('atlas:walkthrough'));
}

/**
 * Close it, and stop it offering itself again in this browser.
 *
 * The scene driver calls this before it photographs anything: a first-visit
 * coach is correct behaviour for a person and pure contamination for a
 * screenshot, and every named scene must be captured as the product looks when
 * you are actually working in it.
 *
 * It deliberately does NOT run `finish()`. This is a teardown, not a completion:
 * the driver is about to set its own scene, and putting the workspace back to a
 * resting result first would be this module reaching into a shot it has nothing
 * to do with.
 */
export function dismissWalkthrough(): void {
  markSeen();
  window.dispatchEvent(new Event('atlas:walkthrough-close'));
}
