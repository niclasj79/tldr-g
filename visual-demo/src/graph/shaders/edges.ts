/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE EDGE SHADER
 * =============================================================================
 *
 * EDGES ARE EARNED, NEVER ALL-ON. This program never sees the full relation set;
 * the engine hands the renderer one of three legible subsets and says which
 * (`stats.drawn_reason`). What this shader is responsible for is making those
 * few thousand strokes carry their σ-class WITHOUT reaching for a sixth colour.
 *
 * -----------------------------------------------------------------------------
 * σ-CLASS IS A TREATMENT, NOT A PALETTE
 * -----------------------------------------------------------------------------
 *   factual     solid            — a claim about the state of the world
 *   temporal    fine dash        — ticks, because it is about instants
 *   causal      tapers to object — the arrow of because, without an arrowhead
 *   episodic    dotted           — discrete events are discrete marks
 *   authorial   hairline         — provenance is quiet; it is not the claim
 *   structural  faintest of all  — the artifact's own skeleton, not a claim
 *
 * Colour stays inside the three lights: --render-deep for the resting skeleton,
 * --render for what the engine is attending to, --evidence for a provenance
 * trace, --alarm for what the truth gate refused. Six treatments, no new hues.
 *
 * -----------------------------------------------------------------------------
 * QUARANTINED EDGES DO NOT REACH THEIR ENDPOINT
 * -----------------------------------------------------------------------------
 * An edge the truth gate rejected is drawn as a BROKEN STUB in --alarm that
 * stops short and fades out. That is the honest picture: the extractor proposed
 * a connection, the gate refused to substantiate it, and the relation therefore
 * does not connect anything. Hiding it would make the gate's work invisible;
 * drawing it whole would make a rejected claim look admitted.
 * ========================================================================== */

import { CAMERA_GLSL, FLAGS_GLSL } from '@/graph/shaders/common';

/** σ-class -> shader code. Order matches `SIGMA_CLASSES` in the contract. */
export const SIGMA_CODE = Object.freeze({
  factual: 0,
  temporal: 1,
  causal: 2,
  episodic: 3,
  authorial: 4,
  structural: 5,
});

/** Not a σ-class: the provenance trace ping, which is old light travelling. */
export const PING_CODE = 9;

/** Per-instance edge flags. Mirrored in `@/graph/edges.ts`. */
export const EDGE_FLAG = Object.freeze({
  /** The truth gate rejected it. Drawn broken, in alarm. */
  QUARANTINED: 1,
  /** On or adjacent to the answer path. Earns the render light. */
  CONSTELLATION: 2,
  /** Both endpoints are on different islands: this crossing is a strait. */
  STRAIT: 4,
  /**
   * A RECEIPTED HOP OF THE ANSWER PATH.
   *
   * Drawn SOLID whatever its σ-class, and that is the whole reason the flag
   * exists. σ-class is a treatment for relations at rest — a dash says "this is
   * about instants", a dot says "these are discrete events". But every graph
   * convention in the world reads a dotted line as INFERRED or UNCERTAIN, so
   * drawing the receipted, evidenced, verified hop of an answer as dots said
   * exactly the opposite of what the receipt says. The path is a claim the
   * engine will show you the bytes for. It is solid.
   */
  ANSWER: 8,
  /** The dark under-stroke beneath an answer hop. Road casing, not a relation. */
  CASING: 16,
  /**
   * THE READING SPINE OF ONE DOCUMENT — not a relation at all.
   *
   * At the passage rung the axis the spans lie on is the document's own byte
   * order, so it is drawn in INK: it carries no σ-class, earns no light, and
   * never fogs. It is the page, and a page is not a claim.
   */
  SPINE: 32,
  /**
   * A MARK, NOT A RELATION — excluded from the stroke count.
   *
   * The reading axis, its two end caps and the banks of a strait crossing are
   * all strokes on the screen, and none of them is a claim between two nodes.
   * Counting them under a word that means "relations drawn" would be the same
   * lie as counting a payload under a word that means "drawn", one layer down.
   */
  MARK: 64,
});

export const EDGE_VERT = /* glsl */ `
${CAMERA_GLSL}
${FLAGS_GLSL}

attribute vec2 aA;       // segment start, world
attribute vec2 aB;       // segment end, world
attribute vec4 aPath;    // (arcAtA, arcAtB) world units, (tAtA, tAtB) 0..1 along the whole route
attribute vec4 aStyle;   // (widthCssPx, sigmaCode, alpha, flags)

uniform float uDim;
uniform float uFogEdge;   // --fog-edge: what an unattended relation keeps
uniform float uTrimPx;    // --edge-trim: how far a route stops short of its endpoints

varying vec3 vLine;   // (signed offset across the stroke in px, half width px, comet length)
varying vec4 vPar;    // (arc in px, t along route, u along this segment, sigma code)
varying vec4 vCol;    // stroke colour + alpha
varying vec4 vScreen; // (device-px position, how much this end LEAVES, how far it goes)

uniform vec3 uRender;
uniform vec3 uRenderDeep;
uniform vec3 uEvidence;
uniform vec3 uAlarm;
uniform vec3 uInk;

/**
 * HOW FAR PAST THE FRAME A POINT LIES, in device pixels. Zero when it is in shot.
 *
 * This is what makes the horizon treatment truthful rather than a blanket
 * vignette. Fading every stroke that merely came near the border dimmed
 * relations that are wholly in shot — a node sitting forty pixels from the rail
 * had its perfectly complete relations drawn as though they were leaving, which
 * is the same lie as severing them, told the other way round. Only an end that
 * is ACTUALLY off-camera earns the treatment, and because the test is exact the
 * treatment can be strong enough to read.
 */
float beyondPx(vec2 p) {
  vec2 lo = -p;
  vec2 hi = p - uViewport;
  return max(max(max(lo.x, hi.x), max(lo.y, hi.y)), 0.0);
}

void main() {
  float sigma = aStyle.y;
  float flags = aStyle.w;
  bool quar    = hasFlag(flags, 1.0);
  bool constel = hasFlag(flags, 2.0);
  bool answer  = hasFlag(flags, 8.0);
  bool casing  = hasFlag(flags, 16.0);
  bool spine   = hasFlag(flags, 32.0);
  bool isPing  = sigma > 8.5;
  // A receipted hop is solid. See EDGE_FLAG.ANSWER.
  if (answer) sigma = 0.0;

  vec2 sa = worldToScreen(aA);
  vec2 sb = worldToScreen(aB);

  /* Measured BEFORE the quarantine cut and before the endpoint trim, because
   * the question is where the relation's two ends really are, not where this
   * stroke happens to stop.
   *
   * HOW FAR OUT IT GOES IS PART OF THE FACT. A relation whose target sits just
   * past the rail is nearly in shot; one whose target is two screens away is
   * somewhere else entirely, and the map should not draw those two the same
   * length at the same weight. So the distance past the border widens the band
   * the stroke runs out over — the further away the other end is, the earlier
   * this one lets go of it. Normalised against the SHORT side of the viewport,
   * so the same relation reads identically at 1080p and at 4K. */
  float shortSide = 0.5 * min(uViewport.x, uViewport.y);
  float pastA = beyondPx(sa);
  float pastB = beyondPx(sb);
  float leaveA = smoothstep(0.0, cssPx(3.0), pastA);
  float leaveB = smoothstep(0.0, cssPx(3.0), pastB);
  float reachA = clamp(pastA / max(shortSide, 1.0), 0.0, 1.0);
  float reachB = clamp(pastB / max(shortSide, 1.0), 0.0, 1.0);

  // A rejected relation stops short of the node it claims to reach.
  if (quar) sb = mix(sa, sb, 0.58);

  vec2 d = sb - sa;
  float len = length(d);
  if (len < 0.25) { gl_Position = cullVertex(); return; }
  vec2 dir = d / len;

  /* A RELATION RUNS BETWEEN TWO THINGS, NOT THROUGH THEM.
   *
   * Trimmed in SCREEN space, because the thing it has to clear — the node's
   * drawn disc — is a screen-space quantity clamped by --node-dot-max, not a
   * world one. Trimming by the baked world radius instead was right at exactly
   * one altitude and wrong at every other, which is how the flagship frame ended
   * up with a path that stopped a hundred pixels short of the entity it named.
   *
   * Only the FIRST and LAST segment of a route are trimmed; aPath.zw carries
   * the position along the whole route, so a bundled corridor keeps its interior
   * intact. */
  float trim = cssPx(uTrimPx);
  float head = aPath.z <= 0.0001 ? min(trim, len * 0.35) : 0.0;
  float tail = aPath.w >= 0.9999 ? min(trim, len * 0.35) : 0.0;
  if (!isPing && (head > 0.0 || tail > 0.0)) {
    sa += dir * head;
    sb -= dir * tail;
    d = sb - sa;
    len = max(length(d), 0.25);
    dir = d / len;
  }

  vec2 nrm = vec2(-dir.y, dir.x);

  float u = position.x;          // 0 at A, 1 at B
  float v = position.y;          // -1 .. 1 across the ribbon
  float t = isPing ? u : mix(aPath.z, aPath.w, u);

  float w = cssPx(aStyle.x);
  if (abs(sigma - 4.0) < 0.5) w *= 0.60;                 // authorial: a hairline
  float taper = (abs(sigma - 2.0) < 0.5) ? mix(1.0, 0.40, t) : 1.0;  // causal: tapers to the object
  float halfW = max(w * taper, cssPx(0.30)) * 0.5 + cssPx(0.55);

  vec2 p = mix(sa, sb, u) + nrm * v * halfW;

  // Reject offscreen segments before they cost a single fragment.
  vec2 mid = mix(sa, sb, 0.5);
  if (offscreen(mid, len * 0.5 + halfW + cssPx(2.0))) { gl_Position = cullVertex(); return; }

  vec3 col = uRenderDeep;
  float alpha = aStyle.z;
  if (abs(sigma - 5.0) < 0.5) alpha *= 0.45;   // structural: the faintest of all
  if (constel) { col = uRender; alpha = min(1.0, alpha * 1.9); }
  // The casing is the ROAD UNDER THE ROAD: --render-deep, wide, so the bright
  // core reads as a line laid over the terrain rather than as a scratch in it,
  // and survives crossing a lit landmass.
  if (casing) { col = uRenderDeep; }
  // The document's own reading axis. Ink, because it is the page.
  if (spine)   { col = uInk; }
  if (quar)    { col = uAlarm;  alpha = min(alpha, 0.28); }
  if (isPing)  { col = uEvidence; }

  // Fog of war. The constellation and the evidence trace never recede.
  if (!constel && !isPing && !answer && !casing && !spine) alpha *= mix(1.0, uFogEdge, uDim);

  /* THE HORIZON. A relation whose far endpoint is off-camera used to be sliced
   * off flat at the frame edge, so the asset and passage rungs read as a bundle
   * of severed wires leading to nowhere — the map claiming a connection it was
   * not showing either end of. The relation really does continue, and the map
   * has to say THAT rather than draw a line to nothing.
   *
   * So the outbound part of such a stroke RUNS OFF: it narrows and dissolves
   * over the last --edge-horizon pixels and is gone before it reaches the
   * border, which is what a thing receding out of the picture looks like. The
   * narrowing is the direction cue — no dash, no arrowhead, because a dash
   * already means "temporal" in this renderer and an arrowhead already means
   * "causal", and the horizon is neither.
   *
   * The leave amount is carried per-vertex, so the treatment ramps in along the segment
   * from the end that stays to the end that goes, and a stroke with both ends in
   * shot is not touched at all. The answer path and the provenance trace are
   * exempt: those two are framed whole by construction, and fading one of them
   * would be hiding the subject. */
  float horizon = (answer || casing || isPing) ? 0.0 : 1.0;
  float leave = horizon * mix(leaveA, leaveB, u);
  float reach = mix(reachA, reachB, u);

  // vLine.z does double duty: the comet length for a ping, the quarantine marker
  // otherwise. Neither meaning can occur on the same instance as the other.
  vLine = vec3(v * halfW, halfW, isPing ? max(aPath.w, 0.02) : (quar ? 1.0 : 0.0));
  vPar  = vec4(mix(aPath.x, aPath.y, u) * uCam.z, isPing ? aPath.z : t, u, sigma);
  vCol  = vec4(col, alpha);
  vScreen = vec4(p, leave, reach);

  gl_Position = screenToClip(p);
}
`;

export const EDGE_FRAG = /* glsl */ `
uniform float uDashPx;     // CSS px, --edge-dash
uniform float uDpr;
uniform vec2 uViewport;    // drawing buffer size, device px
uniform float uHorizonPx;  // CSS px, --edge-horizon

varying vec3 vLine;
varying vec4 vPar;
varying vec4 vCol;
varying vec4 vScreen;

void main() {
  float dist = abs(vLine.x);
  float halfW = vLine.y;

  /* ---- the horizon, first, because it narrows the stroke ------------------
   * Measured at the FRAGMENT, not interpolated from the ends: a stroke that
   * leaves the frame is usually one long segment, and a linear ramp between its
   * two endpoints would fade the whole line instead of the last inch of it.
   *
   * vScreen.z is how much THIS point of the stroke belongs to an end that is
   * genuinely off-camera, so a relation with both endpoints in shot never enters
   * this branch however close to the border it runs. */
  float horizonA = 1.0;
  float leave = vScreen.z;
  if (leave > 0.002) {
    float d = min(min(vScreen.x, uViewport.x - vScreen.x), min(vScreen.y, uViewport.y - vScreen.y));
    /* 0 at the border, 1 a full band inside it.
     *
     * --edge-horizon is the margin, and it is the FLOOR: an endpoint just past
     * the rail is nearly in shot and runs out over exactly the authored margin.
     * An endpoint a screen away is somewhere else entirely, and the band grows
     * with how far away that is — expressed as a fraction of the frame's own
     * short side, so it is the same relation at 1080p and at 4K, and so the only
     * length in the expression is still the token. */
    float sSide = 0.5 * min(uViewport.x, uViewport.y);
    float band = max(max(uHorizonPx * uDpr, 1.0), sSide * vScreen.w * 0.55);
    float k = clamp(d / band, 0.0, 1.0);
    // Gone BEFORE the border rather than cut off at it: a stroke that still has
    // colour in the last row of pixels is a severed one however faint it is.
    float run = smoothstep(0.08, 0.95, k);
    // Narrowing is the direction cue: the stroke recedes rather than stopping.
    halfW *= mix(mix(0.34, 1.0, run), 1.0, 1.0 - leave);
    horizonA = mix(1.0, run, leave);
  }

  float core = 1.0 - smoothstep(halfW - 0.9, halfW, dist);
  if (core <= 0.0) discard;

  float sigma = vPar.w;
  float alpha = vCol.a * core * horizonA;

  // ---- σ-class treatments -------------------------------------------------
  float dash = uDashPx * uDpr;
  if (abs(sigma - 1.0) < 0.5) {
    // temporal: a fine, even dash
    float ph = fract(vPar.x / dash);
    alpha *= 1.0 - smoothstep(0.52, 0.60, ph);
  } else if (abs(sigma - 3.0) < 0.5) {
    // episodic: discrete dots for discrete events
    float ph = fract(vPar.x / (dash * 0.55));
    alpha *= 1.0 - smoothstep(0.30, 0.40, ph);
  }

  if (sigma > 8.5) {
    // the provenance trace: a comet of OLD LIGHT running toward the target
    float behind = vPar.y - vPar.z;
    alpha *= behind >= 0.0 ? exp(-behind / vLine.z) : 0.0;
  } else if (vLine.z > 0.5) {
    // quarantine: the stub dissolves rather than ending in a hard cap, because
    // an unadmitted relation does not arrive anywhere.
    alpha *= 1.0 - smoothstep(0.45, 1.0, vPar.z);
  }

  if (alpha < 0.004) discard;
  gl_FragColor = vec4(vCol.rgb * alpha, alpha);
}
`;
