/**
 * =============================================================================
 * VERIFICATION — and the control that breaks it on purpose
 * =============================================================================
 *
 * The receipt is signed with a real Ed25519 key over a real canonicalisation.
 * This panel runs the real verifier and reports BOTH HALVES SEPARATELY, because
 * "the bytes moved" and "the signature is forged" are different accusations:
 *
 *   payload_hash_matches   recomputing SHA-256 over the canonical payload
 *                          reproduces the hash the trace claims
 *   signature_valid        the detached signature verifies against the key the
 *                          DID resolves to
 *
 * `valid` is their conjunction and is the only field the badge reads. Collapsing
 * the two into one green tick would throw away the entire diagnostic value of
 * signing anything.
 *
 * -----------------------------------------------------------------------------
 * BOTH STATES ARE DESIGNED. NEITHER IS AN AFTERTHOUGHT.
 * -----------------------------------------------------------------------------
 * VALID is quiet: an --ok dot, the identity, the key, the hash. It does not
 * congratulate anybody. A receipt verifying is the normal case and normal cases
 * do not get fireworks.
 *
 * INVALID is --alarm at full strength, and it NAMES THE VERDICT — the engine's
 * own sentence, not a paraphrase — and then shows the mutated bytes. Red here is
 * earned: something is actually wrong, and the panel says exactly what.
 *
 * AND IT TAKES THE TOP OF THE RAIL. `verify-valid` and `verify-invalid` were
 * photographed side by side and were the same picture apart from one 280px card
 * wedged into the bottom-right corner, below three other sections, off the
 * bottom of a 1440px frame. The most severe state the system can report had less
 * compositional weight than a legend. A premium instrument changes its POSTURE
 * when integrity fails: on a failure this panel moves to the head of the column
 * (`order`, set by its own stylesheet — no other component is asked to know) and
 * the receipt gives up the position it holds in every other state. The valid
 * case does not move, because the contrast between the two frames is the point.
 *
 * -----------------------------------------------------------------------------
 * IT VERIFIES WITHOUT BEING ASKED
 * -----------------------------------------------------------------------------
 * A restored view is the highest-stakes trust moment in the product — somebody
 * else's signed claim arriving on your screen — and it was the moment the
 * interface was most passive: a full-confidence answer presented under a grey
 * `UNVERIFIED / Nothing has been checked` card and an 11px button, with no
 * reason given to press it. Nobody presses it.
 *
 * So verification runs on arrival, once per payload, exactly as the independent
 * re-derivation does. It is local, synchronous and free; the argument for
 * withholding it was never about cost. This is NOT green-by-default: the check
 * is really performed, `checked_at` records when, and a receipt that fails
 * arrives already red. What is removed is the state where the product knows the
 * answer and waits to be asked.
 *
 * -----------------------------------------------------------------------------
 * THE TAMPER CONTROL IS PLAYFUL; THE FAILURE IS NOT
 * -----------------------------------------------------------------------------
 * `tamper()` rewrites a digit inside a quote, or flips the last nibble of the
 * signature, or points the receipt at a DID this build cannot resolve. There is
 * no boolean anywhere in it. The badge goes red because the maths comes out
 * different, and this panel proves that by DIFFING THE PRISTINE TRACE AGAINST
 * THE MUTATED ONE and pointing at the character that changed — plus, when the
 * payload moved, the claimed hash and the recomputed hash side by side.
 *
 * A tamper button whose failure you have to take on faith is a magic trick. A
 * tamper button that shows you the byte is a demonstration.
 *
 * -----------------------------------------------------------------------------
 * AND THE VERDICT REACHES THE MAP
 * -----------------------------------------------------------------------------
 * The two verification frames were still the same picture ABOVE the rail. The
 * rail struck the answer through and named the half that failed while, four
 * hundred pixels to the left, the terrain went on drawing the answer path at
 * full attention with its evidence intact — a receipt repudiated in 12px and
 * vouched for in the largest object on screen.
 *
 * So this panel mounts `<RepudiationLayer />`, which strikes the rendered path,
 * breaks the ring on every node of it and puts the engine's own badge and
 * sentence beside the constellation. It draws on real projected positions or it
 * draws nothing at all. See `RepudiationLayer` and `mapProbe`.
 * =============================================================================
 */

import { useEffect, useRef, useState } from 'react';

import { COPY, verifyCopy } from '@/copy';
import { payloadHash, tracePayload } from '@/engine';
import type { RenderTraceV1, TamperKind, VerifyResult } from '@/engine';
import { useAtlas, useAtlasStore } from '@/state';
import {
  Btn,
  Divider,
  Panel,
  SectionLabel,
  StateDot,
  Tip,
  cx,
} from '@/ui/primitives';

import { RepudiationLayer } from './RepudiationLayer';
import { Code, Digest, Fact, Note, Why } from './bits';
import { firstDifference, sliceAround, type MutationSlice } from './diff';

/* =============================================================================
 * 1. WHAT ACTUALLY CHANGED
 * ========================================================================== */

/** One field of the trace, named the way the deck names it. */
interface FieldRef {
  label: string;
  before: string;
  after: string;
}

/**
 * Every field the tamper control can reach, in the order it is worth checking.
 *
 * Enumerated rather than deep-compared so the panel can put the deck's OWN name
 * on whatever moved — "Signature", "Signer", "Passage" — instead of printing a
 * JSON path at somebody.
 */
function comparableFields(pristine: RenderTraceV1, current: RenderTraceV1): FieldRef[] {
  const out: FieldRef[] = [
    {
      label: COPY.trust.signature.rows.sig.label,
      before: pristine.signature.sig,
      after: current.signature.sig,
    },
    {
      label: COPY.trust.signature.rows.did.label,
      before: pristine.signature.did,
      after: current.signature.did,
    },
    {
      label: COPY.trust.signature.rows.keyId.label,
      before: pristine.signature.key_id,
      after: current.signature.key_id,
    },
    {
      label: COPY.trust.signature.rows.alg.label,
      before: pristine.signature.alg,
      after: current.signature.alg,
    },
  ];
  const n = Math.min(pristine.citations.length, current.citations.length);
  for (let i = 0; i < n; i++) {
    out.push({
      label: COPY.receipt.citations.rows.passage.label,
      before: pristine.citations[i].quote,
      after: current.citations[i].quote,
    });
  }
  return out;
}

interface Mutation {
  label: string;
  before: MutationSlice;
  after: MutationSlice;
}

/** The first field whose bytes differ, sliced around the differing character. */
function findMutation(pristine: RenderTraceV1 | null, current: RenderTraceV1): Mutation | null {
  if (pristine === null || pristine === current) return null;
  for (const field of comparableFields(pristine, current)) {
    const at = firstDifference(field.before, field.after);
    if (at < 0) continue;
    return {
      label: field.label,
      before: sliceAround(field.before, at),
      after: sliceAround(field.after, at),
    };
  }
  return null;
}

/** One line of mutated bytes with the changed character marked in place. */
function MutationLine({ slice, tone }: { slice: MutationSlice; tone: 'dim' | 'alarm' }): JSX.Element {
  return (
    <span className={cx('pv-mut-line', `tone-${tone}`)}>
      {slice.headCut ? <span className="pv-src-cut">…</span> : null}
      <span className="pv-mut-ctx">{slice.head}</span>
      <span className="pv-mut-char">{slice.at}</span>
      <span className="pv-mut-ctx">{slice.tail}</span>
      {slice.tailCut ? <span className="pv-src-cut">…</span> : null}
    </span>
  );
}

/* =============================================================================
 * 2. THE BADGE — reusable, because the receipt carries one too
 * ========================================================================== */

export interface VerifyBadgeProps {
  verify: VerifyResult | null;
  className?: string;
}

/**
 * The one-line verdict. Quiet when valid, --alarm when not, --ink-faint when
 * nothing has been checked — never green-by-default, which is the single most
 * common way a trust badge lies.
 */
export function VerifyBadge({ verify, className }: VerifyBadgeProps): JSX.Element {
  const copy = verifyCopy(verify);
  const tone = verify === null ? 'faint' : verify.valid ? 'ok' : 'alarm';
  const dot = verify === null ? 'off' : verify.valid ? 'on' : 'fail';
  return (
    <Tip content={copy.body}>
      <span className={cx('pv-badge', `tone-${tone}`, className)}>
        <StateDot state={dot} tone={tone} />
        <span className="pv-badge-t">{copy.badge}</span>
      </span>
    </Tip>
  );
}

/* =============================================================================
 * 3. THE PANEL
 * ========================================================================== */

export interface VerificationPanelProps {
  trace?: RenderTraceV1 | null;
  verify?: VerifyResult | null;
  tampered?: boolean;
  /** Defaults to the store's `verifyActive`. */
  onVerify?: () => void;
  /** Defaults to the store's `tamperActive`. */
  onTamper?: (kind: TamperKind) => void;
  /** Defaults to the store's `restoreTrace`. */
  onRestore?: () => void;
  className?: string;
}

const TAMPER_KINDS: TamperKind[] = ['payload', 'signature', 'did'];

export function VerificationPanel({
  trace,
  verify,
  tampered,
  onVerify,
  onTamper,
  onRestore,
  className,
}: VerificationPanelProps): JSX.Element {
  const store = useAtlasStore((s) => ({
    trace: s.trace,
    verify: s.verify,
    tampered: s.tampered,
  }));

  const t = trace !== undefined ? trace : store.trace;
  const v = verify !== undefined ? verify : store.verify;
  const isTampered = tampered !== undefined ? tampered : store.tampered;

  /* The pristine copy, kept HERE. The store replaces the trace with the mutated
     one — correctly, because that is what is now on screen — so the only place
     that can still show what it used to be is whoever saw it first. */
  const pristine = useRef<RenderTraceV1 | null>(null);
  useEffect(() => {
    if (t !== null && !isTampered) pristine.current = t;
  }, [t, isTampered]);

  /* VERIFY ON ARRIVAL, ONCE PER PAYLOAD. Latched on `payload_hash` rather than
     on the trace object, so a re-render, a tab switch or a second mount cannot
     re-run it — and a genuinely different receipt always does. `verify !== null`
     clears the latch so a restore, which seats a fresh trace with no verdict,
     is checked rather than announced as unchecked. */
  const checked = useRef<string | null>(null);
  const payloadKey = t?.payload_hash ?? null;
  useEffect(() => {
    if (payloadKey === null) return;
    if (v !== null) {
      checked.current = payloadKey;
      return;
    }
    if (checked.current === payloadKey) return;
    checked.current = payloadKey;
    if (onVerify) onVerify();
    else useAtlas.getState().verifyActive();
  }, [payloadKey, v, onVerify]);

  const [busy, setBusy] = useState(false);

  if (t === null) {
    return (
      <Panel title={COPY.trust.signature.title} className={cx('pv-panel', 'pv-verify', className)}>
        <Note>{COPY.receipt.empty}</Note>
      </Panel>
    );
  }

  const copy = verifyCopy(v);
  const invalid = v !== null && !v.valid;
  const mutation = isTampered ? findMutation(pristine.current, t) : null;

  /* Recomputed here, in the panel, from the trace the panel is holding. When it
     disagrees with the claimed hash the two are printed together — the whole
     accusation, visible, rather than a red word. */
  const recomputed = payloadHash(tracePayload(t));
  const hashMoved = recomputed !== t.payload_hash;
  /** The half that accuses the SIGNER rather than the bytes. */
  const badSignature = v !== null && !v.signature_valid;

  const doVerify = (): void => {
    if (onVerify) onVerify();
    else useAtlas.getState().verifyActive();
  };
  const doTamper = (kind: TamperKind): void => {
    if (onTamper) onTamper(kind);
    else useAtlas.getState().tamperActive(kind);
  };
  const doRestore = (): void => {
    if (onRestore) {
      onRestore();
      return;
    }
    setBusy(true);
    void useAtlas
      .getState()
      .restoreTrace()
      .finally(() => setBusy(false));
  };

  return (
    <>
    {/* THE VERDICT REACHES THE MAP. A repudiated receipt whose constellation
        still looks receipted is the interface lying about the engine in the
        largest type it has. This portals over the terrain and draws nothing
        when there is nothing to repudiate — or when it cannot verify where the
        nodes are. */}
    <RepudiationLayer />
    <Panel
      title={
        <Why note={COPY.trust.signature.note}>
          <span>{COPY.trust.signature.title}</span>
        </Why>
      }
      tone={invalid ? 'alarm' : 'evidence'}
      className={cx('pv-panel', 'pv-verify', invalid && 'is-invalid', className)}
      scroll
    >
      {/* ---- THE KEY DISCLOSURE ------------------------------------------
          Above the verdict, deliberately. A visitor to the published demo can
          otherwise read a green badge and a did:web: signer and reasonably
          conclude something was authenticated. Nothing was: the private key is
          printed in this app's source. The disclosure belongs before the verdict
          it qualifies, not in a tooltip underneath it — the interface never lies
          about the engine, and an omission at this spot is the loudest lie
          available to it. */}
      <p className="pv-demo-key t-11 ink-faint">{COPY.trust.signature.demoKey}</p>
      {/* ---- THE VERDICT -------------------------------------------------
          At heading scale on a failure, and it names WHICH HALF failed in the
          engine's own sentence. This is the object the whole panel exists to
          produce, so nothing precedes it and nothing is the same size as it. */}
      <section
        className={cx(
          'pv-verdict',
          invalid ? 'is-invalid tone-alarm' : v === null ? 'is-unchecked tone-faint' : 'is-valid tone-ok',
        )}
      >
        <div className="pv-verdict-hd">
          <VerifyBadge verify={v} />
        </div>
        {/* THE VALID CASE DOES NOT EXPLAIN ITSELF ON THE RAIL. Five lines of grey
            prose about what was checked is the right thing to have and the wrong
            thing to print when the answer is "nothing moved" — it makes success
            as loud as failure, which is the reason the two frames used to look
            alike. Valid states its verdict and stops; failure and not-yet-checked
            keep their paragraph, because in those two the paragraph is the
            diagnosis and the instruction. */}
        {invalid || v === null ? (
          <p className="pv-verdict-title" data-prose>
            {copy.title}
          </p>
        ) : (
          <Why note={copy.body}>
            <p className="pv-verdict-title" data-prose>
              {copy.title}
            </p>
          </Why>
        )}
        {invalid || v === null ? <Note>{copy.body}</Note> : null}
        {v === null ? null : <Code code={v.verdict} />}
        {/* THE CONTROL IS FULL WIDTH WHILE NOTHING HAS BEEN CHECKED. An 11px
            button in a header is a control the eye files as chrome; this is the
            one state where the reader has to be handed something to press. It
            stays --render in every state — running the verifier is the engine
            attending to something, and --alarm belongs to the result. */}
        <div className={cx('pv-actions', v === null && 'is-lead')}>
          <Btn
            variant={v === null ? 'primary' : 'ghost'}
            size="sm"
            tone="render"
            onClick={doVerify}
            title={COPY.trust.verify.action.title}
            className={v === null ? 'pv-btn-wide' : undefined}
          >
            {COPY.trust.verify.action.label}
          </Btn>
        </div>
      </section>

      {/* ---- THE TWO HALVES, SEPARATELY ----------------------------------
          THE PAIR IS THE DIAGNOSIS, SO IT IS DRAWN AS A PAIR. As two stacked
          `<Row>`s with a hairline between them, the panel's central finding read
          as rows three and four of a compliance table — the same shape, weight
          and rhythm as `Algorithm  Ed25519`. Side by side in one strip, the two
          booleans can be COMPARED, which is the only reason they are reported
          separately at all: `false / true` says the bytes moved and the header
          did not, and that reading is a glance rather than a scan.

          Printed as booleans, not as a paraphrase: a bare coloured dot says
          nothing to a reader who cannot separate red from green, and the payload
          carries these as `true` / `false`. */}
      <section className="pv-sec">
        <Why note={`${COPY.trust.verify.separately} ${COPY.trust.verify.note}`}>
          <SectionLabel>{COPY.trust.verify.action.label}</SectionLabel>
        </Why>
        <div className="pv-facts pv-halves">
          <Fact
            label={COPY.trust.verify.halves.payload.label}
            tip={COPY.trust.verify.halves.payload.tip}
          >
            <StateDot
              state={v === null ? 'off' : v.payload_hash_matches ? 'on' : 'fail'}
              tone={v === null ? 'faint' : v.payload_hash_matches ? 'ok' : 'alarm'}
              label={v === null ? COPY.common.notRun : String(v.payload_hash_matches)}
            />
          </Fact>
          <Fact
            label={COPY.trust.verify.halves.signature.label}
            tip={COPY.trust.verify.halves.signature.tip}
          >
            <StateDot
              state={v === null ? 'off' : v.signature_valid ? 'on' : 'fail'}
              tone={v === null ? 'faint' : v.signature_valid ? 'ok' : 'alarm'}
              label={v === null ? COPY.common.notRun : String(v.signature_valid)}
            />
          </Fact>
          {v === null ? null : (
            <Fact
              label={COPY.trust.verify.checkedAt.label}
              tip={COPY.trust.verify.checkedAt.tip}
              wide
              mono
            >
              {v.checked_at}
            </Fact>
          )}
        </div>
      </section>

      <Divider />

      {/* ---- THE SIGNATURE -----------------------------------------------
          THE DIGESTS ARE PRINTED IN FULL, WRAPPED, CLICK-TO-COPY. They used to
          truncate to `e72a68455ebb …` in a right-aligned row while four lines
          of prose about why signing matters sat above them — provenance whose
          own identifiers were the part that got elided. A verifier who cannot
          lift the digest cannot verify, so the digest gets the width and the
          prose goes on the heading. The panel title already says `Signature`;
          a second heading here would be the instrument repeating itself. */}
      <section className="pv-sec">
        {/* NO SECTION LABEL. Every block below names itself — `Payload hash`,
            `Derived`, `Signature`, `Signer`, `Key` — and the panel is called
            Signature. A heading here would be the third time in 200px that the
            instrument said the word. The note that used to sit under it is on
            the panel's own title. */}
        <Digest
          value={t.payload_hash}
          label={COPY.trust.signature.rows.payloadHash.label}
          tone={hashMoved ? 'alarm' : 'evidence'}
        />
        {/* The recomputation, shown only when it disagrees. When it agrees the
            state dot above has already said so and a second hash would be noise.
            It brings its own alarm frame; a second one around it was two borders
            saying the same thing. */}
        {hashMoved ? <Digest value={recomputed} label={COPY.common.derived} tone="alarm" /> : null}
        <Digest
          value={t.signature.sig}
          label={COPY.trust.signature.rows.sig.label}
          tone={badSignature ? 'alarm' : 'evidence'}
        />
        {/* THE IDENTITY IS NOT A TABLE. `Key` was a right-aligned row, so a
            38-character key id broke as `did:web:tldr-g.example#atlas-demo-` /
            `key-1` — two lines ragged against the wrong edge, split mid-token.
            A verifier who cannot lift the key cannot verify, which makes that
            the same defect the digests above were fixed for. Label above,
            value on the full measure, left-aligned, wrapping. */}
        <div className="pv-facts pv-signer">
          <Fact
            label={COPY.trust.signature.rows.did.label}
            tip={COPY.trust.signature.rows.did.tip}
            tone={badSignature ? 'alarm' : 'neutral'}
            wide
            mono
          >
            {t.signature.did}
          </Fact>
          <Fact
            label={COPY.trust.signature.rows.keyId.label}
            tip={COPY.trust.signature.rows.keyId.tip}
            tone={badSignature ? 'alarm' : 'dim'}
            wide
            mono
          >
            {t.signature.key_id}
          </Fact>
          <Fact
            label={COPY.trust.signature.rows.alg.label}
            tip={COPY.trust.signature.rows.alg.tip}
            mono
          >
            {t.signature.alg}
          </Fact>
        </div>
      </section>

      <Divider />

      {/* ---- BREAK IT ON PURPOSE ----------------------------------------- */}
      <section className="pv-sec">
        <Why note={COPY.trust.tamper.note}>
          <SectionLabel>{COPY.trust.tamper.title}</SectionLabel>
        </Why>
        <div className="pv-actions">
          {TAMPER_KINDS.map((kind) => (
            <Btn
              key={kind}
              variant="quiet"
              size="sm"
              tone="alarm"
              onClick={() => doTamper(kind)}
              title={COPY.trust.tamper.kinds[kind].title}
            >
              {COPY.trust.tamper.kinds[kind].label}
            </Btn>
          ))}
          <Btn
            variant="ghost"
            size="sm"
            tone="render"
            disabled={!isTampered || busy}
            onClick={doRestore}
            title={COPY.trust.tamper.restore.title}
          >
            {COPY.trust.tamper.restore.label}
          </Btn>
        </div>

        {isTampered ? (
          <div className="pv-tampered tone-alarm">
            <Note>{COPY.trust.tamper.tampered}</Note>
            {mutation === null ? null : (
              <div className="pv-mutation">
                <SectionLabel>{mutation.label}</SectionLabel>
                <MutationLine slice={mutation.before} tone="dim" />
                <MutationLine slice={mutation.after} tone="alarm" />
              </div>
            )}
          </div>
        ) : null}
      </section>
    </Panel>
    </>
  );
}
