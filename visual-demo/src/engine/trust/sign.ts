/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE SIGNATURE
 * =============================================================================
 *
 * Real Ed25519 over a real canonicalisation. Nothing here is staged.
 *
 * The product's whole thesis is "the interface never lies about the engine".
 * A badge that reads VALID because a string constant says VALID is not a weaker
 * version of that thesis, it is the opposite of it. So: the trace is
 * canonicalised deterministically, hashed with SHA-256, and the hash is signed
 * with a real Ed25519 key. `verifyTrace()` recomputes both halves and reports
 * them SEPARATELY, because "the bytes changed" and "the signature is forged"
 * are different accusations and the UI must be able to make the right one.
 *
 * -----------------------------------------------------------------------------
 * THE DEMO IDENTITY IS NOT A REAL IDENTITY
 * -----------------------------------------------------------------------------
 * `getDemoKeypair()` derives a FIXED keypair from a constant seed string and
 * publishes it under `did:web:tldr-g.example` — a reserved-for-documentation
 * domain that cannot be registered. The private key is in this file, in plain
 * sight, on purpose: it signs a synthetic corpus so that a reviewer can verify
 * the receipt offline and reproduce every byte of it. It authenticates NOTHING.
 * Do not reuse this key, this DID, or this pattern for anything that matters.
 *
 * -----------------------------------------------------------------------------
 * WHAT IS SIGNED, EXACTLY
 * -----------------------------------------------------------------------------
 *   payload            := the trace MINUS `payload_hash` and MINUS `signature`
 *   trace.payload_hash := 'sha256:' + hex(sha256(utf8(canonicalize(payload))))
 *   trace.signature.sig:= Ed25519(privkey, utf8(trace.payload_hash))
 *
 * The signature covers the CLAIMED hash string, not the recomputed one. That is
 * deliberate and it is what makes the two failure modes separable:
 *
 *   - mutate a quote  -> recomputed hash != claimed hash, but the signature over
 *                        the claimed hash still verifies. `payload_hash_matches`
 *                        goes false, `signature_valid` stays true. The verdict
 *                        can therefore say precisely "the payload moved".
 *   - mutate the sig  -> the hash still matches, the signature does not verify.
 *                        The verdict can say precisely "the header was touched".
 *
 * Collapsing the two booleans into one would throw that distinction away, and
 * the distinction is the entire diagnostic value of the receipt.
 * =============================================================================
 */

import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';

import { CORPUS_PROVENANCE } from '@/engine/types';
import type { ContentHash, IsoTimestamp, RenderTraceV1, VerifyResult } from '@/engine/types';

/* =============================================================================
 * 0. WIRING THE HASH INTO @noble/ed25519 v2
 * -----------------------------------------------------------------------------
 * v2 ships without a bundled SHA-512: the async API borrows WebCrypto, and the
 * synchronous API requires the host to install a hash. We install it once, at
 * module load, from @noble/hashes — the same dependency the corpus already uses
 * for SHA-256 — so that `sign`/`verify` are synchronous. Synchronous matters:
 * verification runs inside a React render path and an `await` there means a
 * frame where the badge shows neither valid nor invalid, which is a lie by
 * omission at 60fps.
 * ========================================================================== */
ed.etc.sha512Sync = (...messages: Uint8Array[]): Uint8Array =>
  sha512(ed.etc.concatBytes(...messages));

/* =============================================================================
 * 1. CANONICALISATION
 * ========================================================================== */

/**
 * Deterministic JSON canonicalisation. Two structurally-equal payloads MUST
 * produce byte-identical output; two different payloads MUST NOT.
 *
 * THE RULES, in full, because a canonicaliser whose rules are undocumented is a
 * canonicaliser nobody can re-implement, and a signature nobody can re-implement
 * is a signature nobody can check:
 *
 *  1. OBJECT KEYS are emitted in ascending order of UTF-16 code unit (plain
 *     `Array.prototype.sort()` on the key strings). Insertion order is a
 *     property of how the object was built, not of what it means.
 *  2. NO INSIGNIFICANT WHITESPACE. No spaces after `:` or `,`, no newlines.
 *  3. `undefined` AS AN OBJECT VALUE OMITS THE KEY ENTIRELY. `{a:1,b:undefined}`
 *     and `{a:1}` are the same payload and must hash the same. `null` is NOT
 *     `undefined`: it is a value, it is emitted, and it changes the hash.
 *  4. `undefined`, functions and symbols INSIDE AN ARRAY become `null`, because
 *     an array's length is data and dropping the element would change it. This
 *     matches `JSON.stringify`.
 *  5. NUMBERS use the ECMAScript Number-to-String algorithm (`String(n)`), which
 *     is the shortest representation that round-trips and is specified exactly,
 *     so it is identical across engines. `-0` is emitted as `0` (JSON has no
 *     negative zero). `NaN` and `±Infinity` THROW rather than silently becoming
 *     `null` — a receipt containing a number that cannot be represented is a
 *     receipt that must not be signed.
 *  6. STRINGS use `JSON.stringify`'s escaping, which is fully specified. Lone
 *     surrogates survive as escapes; the input string's code units are the unit
 *     of identity, not its Unicode normalisation. Callers who need NFC must
 *     normalise BEFORE signing.
 *  7. ARRAY ORDER IS PRESERVED. Order is data. Sorting arrays would make two
 *     genuinely different citation lists hash identically.
 *  8. `toJSON()` IS HONOURED (so `Date` canonicalises to its ISO string), then
 *     the result is canonicalised by these same rules.
 *  9. `bigint` THROWS. JSON has no bigint and coercing loses precision silently.
 * 10. `Map`, `Set` and other exotic objects THROW. Their iteration order is
 *     insertion order, i.e. caller-dependent, i.e. not canonical. Convert to a
 *     sorted array of entries before signing and be explicit about it.
 * 11. CYCLES THROW.
 *
 * @param payload any JSON-shaped value
 * @returns the canonical UTF-16 string; hash its UTF-8 bytes
 */
export function canonicalize(payload: unknown): string {
  const seen = new Set<object>();

  const walk = (value: unknown, path: string): string => {
    // toJSON first, so Date and friends collapse to primitives.
    if (value !== null && typeof value === 'object') {
      const maybe = value as { toJSON?: (key?: string) => unknown };
      if (typeof maybe.toJSON === 'function') {
        return walk(maybe.toJSON(), path);
      }
    }

    if (value === null) return 'null';

    switch (typeof value) {
      case 'boolean':
        return value ? 'true' : 'false';

      case 'number': {
        if (!Number.isFinite(value)) {
          throw new TypeError(
            `[trust/sign] canonicalize: non-finite number at ${path}. A receipt ` +
              `cannot be signed over a value JSON cannot represent.`,
          );
        }
        return Object.is(value, -0) ? '0' : String(value);
      }

      case 'string':
        return JSON.stringify(value);

      case 'bigint':
        throw new TypeError(
          `[trust/sign] canonicalize: bigint at ${path}. Convert it to a string ` +
            `explicitly — silent coercion to Number loses precision.`,
        );

      case 'undefined':
      case 'function':
      case 'symbol':
        // Only reachable from an array slot; object properties are filtered below.
        return 'null';

      case 'object':
        break;

      default:
        throw new TypeError(`[trust/sign] canonicalize: unsupported type at ${path}`);
    }

    const obj = value as object;
    if (seen.has(obj)) {
      throw new TypeError(`[trust/sign] canonicalize: cycle at ${path}`);
    }
    seen.add(obj);
    try {
      if (Array.isArray(obj)) {
        const parts = obj.map((item, i) => walk(item, `${path}[${i}]`));
        return `[${parts.join(',')}]`;
      }

      const tag = Object.prototype.toString.call(obj);
      if (tag !== '[object Object]') {
        throw new TypeError(
          `[trust/sign] canonicalize: ${tag} at ${path} has no canonical ordering. ` +
            `Convert it to a plain object or a sorted array before signing.`,
        );
      }

      const keys = Object.keys(obj as Record<string, unknown>).sort();
      const parts: string[] = [];
      for (const key of keys) {
        const v = (obj as Record<string, unknown>)[key];
        // Rule 3: an undefined property is an absent property.
        if (v === undefined || typeof v === 'function' || typeof v === 'symbol') continue;
        parts.push(`${JSON.stringify(key)}:${walk(v, `${path}.${key}`)}`);
      }
      return `{${parts.join(',')}}`;
    } finally {
      seen.delete(obj);
    }
  };

  return walk(payload, '$');
}

/** The prefix every hash in this build carries, so a bare hex string is never mistaken for one. */
export const HASH_PREFIX = 'sha256:';

/**
 * `sha256:<64 lowercase hex>` over the canonical UTF-8 bytes of `payload`.
 *
 * NOTE the digest is FULL WIDTH here, unlike `Passage.content_hash`, which the
 * corpus truncates to 16 bytes so a human can compare it by eye. This one is a
 * signature input, not a display value, and truncating a signed digest to save
 * screen width is how you turn a security property into a decoration.
 */
export function payloadHash(payload: unknown): ContentHash {
  return HASH_PREFIX + bytesToHex(sha256(utf8ToBytes(canonicalize(payload))));
}

/* =============================================================================
 * 2. THE DEMO IDENTITY
 * ========================================================================== */

/**
 * The seed the demo private key is derived from. It is a sentence, in the
 * source, in a public repository. That is the point: this key exists so that a
 * reviewer can reproduce the signature, not so that anything can be trusted
 * because it carries the signature.
 */
// ⚠️ FROZEN STRING — the private key is derived from these EXACT bytes. It reads
// like a label and is actually key material: edit one character and the demo's
// signing key rotates, every signature it has ever produced stops verifying, and
// scripts/verify-trust.mjs can no longer reproduce a recorded trace. It kept the
// word "atlas" through the rename to "visual demo" for exactly that reason. It is
// deliberately excluded from any global rename; do not "fix" it.
const DEMO_KEY_SEED =
  'tldr-g atlas — demo signing key for a synthetic-design-concept corpus — not a real identity';

/**
 * The signer's DID. `tldr-g.example` is inside the IANA-reserved `.example`
 * TLD: it can never be registered, so this DID can never accidentally resolve
 * to somebody's real key material.
 *
 * A real deployment resolves `did:web:<host>` by fetching
 * `https://<host>/.well-known/did.json` and reading the `verificationMethod`
 * whose `id` matches `key_id`. `resolveDidKey()` below is that lookup, against
 * a one-entry in-memory registry.
 */
export const DEMO_DID = 'did:web:tldr-g.example';

/**
 * The specific key of the DID that signs. Named so rotation does not invalidate
 * archived traces.
 *
 * ⚠️ FROZEN — the `atlas` in the fragment is an IDENTIFIER, not a brand. It is
 * matched by `resolveDidKey()`, printed verbatim in the Verification panel, and
 * its exact length is what the line-break fix in VerificationPanel.tsx is measured
 * against. Renaming it invalidates every archived trace for cosmetic gain. Left as
 * it was by the "visual demo" rename, on purpose.
 */
export const DEMO_KEY_ID = `${DEMO_DID}#atlas-demo-key-1`;

export interface DemoKeypair {
  /** 32-byte Ed25519 seed / private key. Public by design — see the file header. */
  priv: Uint8Array;
  /** 32-byte Ed25519 public key. */
  pub: Uint8Array;
  /** Decentralised identifier of the signing engine instance. */
  did: string;
  /** Which key of the DID signs. */
  key_id: string;
}

let cachedKeypair: DemoKeypair | null = null;

/**
 * The FIXED demo keypair. Deterministic: the private key is SHA-256 of a
 * constant sentence, so every machine that builds this repo produces the same
 * key, the same signature, and the same verifiable receipt.
 *
 * DEMO IDENTITY FOR A SYNTHETIC CORPUS. NOT A REAL KEY. NEVER REUSE IT.
 */
export function getDemoKeypair(): DemoKeypair {
  if (cachedKeypair) return cachedKeypair;
  const priv = sha256(utf8ToBytes(DEMO_KEY_SEED)); // 32 bytes, the ed25519 seed size
  const pub = ed.getPublicKey(priv);
  cachedKeypair = { priv, pub, did: DEMO_DID, key_id: DEMO_KEY_ID };
  return cachedKeypair;
}

/**
 * Resolve a DID (+ key id) to the public key that is allowed to sign for it.
 *
 * Returns `null` for anything this build does not know about — an unknown DID
 * is not an error to swallow, it is a verification failure to report. In a live
 * deployment this is the `did:web` document fetch.
 */
export function resolveDidKey(did: string, keyId?: string): Uint8Array | null {
  if (did !== DEMO_DID) return null;
  if (keyId !== undefined && keyId !== DEMO_KEY_ID) return null;
  return getDemoKeypair().pub;
}

/* =============================================================================
 * 3. SIGN / VERIFY
 * ========================================================================== */

/**
 * The signable payload: the trace minus the two fields that cannot be inside
 * their own preimage. Rest-destructuring rather than an explicit field list, so
 * that a field added to `RenderTraceV1` tomorrow is signed automatically instead
 * of silently escaping the signature.
 */
export function tracePayload(trace: RenderTraceV1): Record<string, unknown> {
  const { payload_hash: _payloadHash, signature: _signature, ...payload } = trace;
  void _payloadHash;
  void _signature;
  return payload as unknown as Record<string, unknown>;
}

/**
 * Attach a DETACHED Ed25519 signature over the trace's payload hash.
 *
 * Returns a NEW trace. The input is not mutated: a receipt that changes under
 * you while it is being displayed is its own kind of dishonesty.
 *
 * `payload_hash` is RECOMPUTED here rather than trusted from the input — signing
 * a hash somebody else handed us would sign a claim, not a fact.
 */
export function signTrace(trace: RenderTraceV1): RenderTraceV1 {
  const { priv, did, key_id } = getDemoKeypair();
  const payload_hash = payloadHash(tracePayload(trace));
  const sig = ed.sign(utf8ToBytes(payload_hash), priv);
  return {
    ...trace,
    payload_hash,
    signature: { alg: 'Ed25519', did, sig: bytesToHex(sig), key_id },
  };
}

/** The three verdict strings. Exported so the UI can style them without re-deriving the wording. */
/**
 * The demo's verdict strings.
 *
 * ⚠️ EVERY ONE IS SCOPE-PREFIXED WITH "demo:" ON PURPOSE. Before that prefix, two of
 * these were BYTE-IDENTICAL to the real verifier's output — `attestation.py` and
 * `verify.html` emit the same sentences, em-dash included — and this demo renders its
 * verdict verbatim in a monospace block. A screenshot or a pasted log line reading
 * "signature valid; payload hash matches" was therefore indistinguishable between a
 * genuine verification and this one, which signs with a key published in plain text a
 * few lines above and authenticates nothing.
 *
 * The strings are the artifact that escapes the app — into screenshots, into issues,
 * into slide decks — so they are where the distinction has to be carried. Do not
 * "harmonise" them with the real verifier's wording.
 */
export const VERDICT = Object.freeze({
  VALID: 'demo: signature valid; payload hash matches (demo key — authenticates nothing)',
  PAYLOAD_MUTATED: 'demo: verification FAILED — payload hash does not match the signed hash',
  SIGNATURE_MUTATED: 'demo: verification FAILED — header or signature tampered',
});

/**
 * Verify a render trace. BOTH HALVES ARE CHECKED AND REPORTED SEPARATELY.
 *
 *   payload_hash_matches — recomputing the hash over the canonicalised payload
 *                          reproduces the hash the trace claims. False means the
 *                          answer, a quote, an admission or an omission moved
 *                          after signing.
 *   signature_valid      — the detached Ed25519 signature verifies against the
 *                          public key the DID resolves to. False means the
 *                          signature, the DID, the key id or the algorithm was
 *                          touched, or the signer is not one we recognise.
 *
 * `valid` is their conjunction and is the ONLY field a badge may read.
 *
 * @param trace the receipt to check
 * @param now   injectable clock; verification time is not part of the signature,
 *              but it is part of the audit line, so it must be recorded.
 */
export function verifyTrace(
  trace: RenderTraceV1,
  now: IsoTimestamp = new Date().toISOString(),
): VerifyResult {
  const recomputed = payloadHash(tracePayload(trace));
  const payload_hash_matches = recomputed === trace.payload_hash;

  let signature_valid = false;
  const pub = resolveDidKey(trace.signature.did, trace.signature.key_id);
  if (pub !== null && trace.signature.alg === 'Ed25519') {
    try {
      signature_valid = ed.verify(
        hexToBytes(trace.signature.sig),
        utf8ToBytes(trace.payload_hash),
        pub,
      );
    } catch {
      // Malformed hex, wrong length, point not on the curve: all of these are
      // "the signature does not verify", not exceptions to leak upwards.
      signature_valid = false;
    }
  }

  const valid = payload_hash_matches && signature_valid;
  const verdict = valid
    ? VERDICT.VALID
    : !signature_valid
      ? VERDICT.SIGNATURE_MUTATED
      : VERDICT.PAYLOAD_MUTATED;

  return {
    valid,
    verdict,
    payload_hash_matches,
    signature_valid,
    checked_at: now,
    did: trace.signature.did,
    corpus_provenance: CORPUS_PROVENANCE,
  };
}

/* =============================================================================
 * 4. THE TAMPER CONTROL
 * ========================================================================== */

/** What `tamper()` breaks. */
export type TamperKind = 'payload' | 'signature' | 'did';

/**
 * Return a MUTATED COPY of the trace so the UI can demonstrate the INVALID
 * state honestly.
 *
 * This is the playful control on the receipt panel — "go on, change it" — and it
 * has to be real or it teaches the wrong lesson. It mutates ACTUAL BYTES:
 *
 *   'payload'   — rewrites a digit inside the first citation's quote. A number
 *                 inside a quotation mark is the most damning thing you can
 *                 alter in a citation, and the change is visible on screen next
 *                 to the failing hash.
 *   'signature' — flips the last hex nibble of the detached signature.
 *   'did'       — points the receipt at a DID this build cannot resolve.
 *
 * There is no boolean anywhere in this function. Nothing is "marked" invalid;
 * the bytes are different, so the maths comes out different.
 */
export function tamper(trace: RenderTraceV1, kind: TamperKind): RenderTraceV1 {
  const copy: RenderTraceV1 = {
    ...trace,
    citations: trace.citations.map((c) => ({ ...c })),
    admitted: trace.admitted.map((a) => ({ ...a })),
    omitted_but_connected: trace.omitted_but_connected.map((p) => ({ ...p })),
    signature: { ...trace.signature },
  };

  switch (kind) {
    case 'payload': {
      if (copy.citations.length === 0) {
        throw new Error('[trust/sign] tamper("payload"): the trace has no citations to alter.');
      }
      copy.citations[0] = { ...copy.citations[0], quote: mutateQuote(copy.citations[0].quote) };
      return copy;
    }

    case 'signature': {
      copy.signature.sig = flipLastHexNibble(copy.signature.sig);
      return copy;
    }

    case 'did': {
      copy.signature.did = 'did:web:not-tldr-g.example';
      return copy;
    }

    default: {
      const never: never = kind;
      throw new Error(`[trust/sign] tamper: unknown kind ${String(never)}`);
    }
  }
}

/**
 * Change one character of a quote, visibly. Prefers the first digit (so
 * "12.8 percent" becomes "22.8 percent" and the forgery is legible); falls back
 * to case-flipping the first letter for quotes with no digits.
 */
function mutateQuote(quote: string): string {
  const digit = quote.search(/[0-9]/);
  if (digit >= 0) {
    const next = String((Number(quote[digit]) + 1) % 10);
    return quote.slice(0, digit) + next + quote.slice(digit + 1);
  }
  const letter = quote.search(/[A-Za-z]/);
  if (letter >= 0) {
    const ch = quote[letter];
    const flipped = ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase();
    return quote.slice(0, letter) + flipped + quote.slice(letter + 1);
  }
  // A quote with neither a digit nor a letter still has to actually change.
  return `${quote}.`;
}

/** Flip the final hex digit of a signature to a different one. Real bytes, not a flag. */
function flipLastHexNibble(sig: string): string {
  if (sig.length === 0) return '0';
  const last = sig[sig.length - 1];
  const alphabet = '0123456789abcdef';
  const i = alphabet.indexOf(last.toLowerCase());
  const next = i < 0 ? '0' : alphabet[(i + 1) % 16];
  return sig.slice(0, -1) + next;
}
