/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE POINT SHADER
 * =============================================================================
 *
 * ONE DRAW CALL FOR THE WHOLE KNOWLEDGE TERRAIN. Every node in the bake — every
 * continent, island, asset, entity, passage and source — is one instance of a
 * unit quad in this program. At 100,000 nodes that is 400,000 vertex shader
 * invocations and a single `drawElementsInstanced`.
 *
 * -----------------------------------------------------------------------------
 * WHAT A NODE LOOKS LIKE, AND WHY
 * -----------------------------------------------------------------------------
 * A leaf node (passage, entity, source) is a soft-edged disc with a crisp 1px
 * rim. The rim is what makes 6,000 of them read as a material rather than as
 * blur — a disc with no edge is a smudge, and a terrain made of smudges has no
 * grain to read.
 *
 * A REGION node (continent, island, asset) is drawn as its BOUNDARY: a thin ring
 * at the node's true containment radius from the bake, plus a small filled
 * capital at its centroid. This is not decoration. An asset is a molecule with a
 * DECLARED BOUNDARY — somebody said "this is one thing" — and the honest glyph
 * for a declared boundary is the boundary. The ring encloses exactly the
 * children the bake placed inside it, so containment is something you can see
 * rather than something the legend claims.
 *
 * -----------------------------------------------------------------------------
 * THE RESOLUTION RAMP IS APPLIED HERE, CONTINUOUSLY
 * -----------------------------------------------------------------------------
 * `aLod` is a float, not an enum. Opacity, stroke width, glow radius, edge
 * softness and whether the body is filled at all are all read off the ramp at a
 * fractional index, so a node that is re-admitted at a different resolution
 * CROSSFADES THROUGH the ramp. `latent` (12%, outline only) is the far end: the
 * fill drops to zero and what remains is a 1px outline. That is the point of
 * latent — omitted content is still present as topology, and you can see both
 * that it is there and that nothing was spent on it.
 *
 * GLOW IS DATA. It is a 6px screen-space falloff, it exists on `lod-0` and on
 * selection only, its radius comes from `--lod-0-glow`, and there is no bloom
 * pass anywhere in this renderer.
 * ========================================================================== */

import { CAMERA_GLSL, FLAGS_GLSL, HUE_GLSL, RAMP_GLSL } from '@/graph/shaders/common';

/* -----------------------------------------------------------------------------
 * The per-instance flag bitfield. Mirrored exactly in `@/graph/points.ts`.
 * -------------------------------------------------------------------------- */
export const NODE_FLAG = Object.freeze({
  /** The user picked it. Earns the render light and the glow. */
  SELECTED: 1,
  /** The pointer is on it. */
  HOVERED: 2,
  /** A bridge entity: its mentions span two islands. Drawn with a second boundary. */
  BRIDGE: 4,
  /** The truth gate rejected the claims around it. Boundary drawn BROKEN, in alarm. */
  QUARANTINED: 8,
  /** Part of the answer constellation the engine rendered. */
  CONSTELLATION: 16,
  /** A region node (continent / island / asset): boundary ring + capital. */
  REGION: 32,
  /** The single focused node. The fovea. */
  FOCUS: 64,
  /**
   * Draw this region's BOUNDARY, not just its capital.
   *
   * Boundaries are drawn ON DEMAND, not at rest. Thirty-six islands whose
   * containment radii legitimately overlap produce a Spirograph, and a
   * Spirograph is the hairball with circles instead of lines. So a boundary is
   * shown for what you are pointing at, what you have selected, and the region
   * you are standing inside — the cases where "what exactly does this contain"
   * is the question being asked.
   */
  RING: 128,
  /**
   * THIS NODE IS A BODY OF THE RUNG YOU ARE STANDING ON.
   *
   * The load-bearing flag for "zoom changes meaning, not scale". A continent
   * seen from the continent rung is the SUBJECT of the screen and is drawn as a
   * large luminous mass; the same continent seen from the island rung is context
   * and shrinks back to a capital. Without this, every rung draws the same
   * 2.6px dot over the same point cloud and all four altitudes are one picture.
   */
  PRIMARY: 256,
  /**
   * The terminal of the answer path — the thing the question asked for.
   *
   * It gets the largest mark the terrain draws and its own ring, because in the
   * frame that goes in the deck the one entity being NAMED must be the one
   * entity you can find.
   */
  ANSWER: 512,
  /** On the answer path: a hop endpoint or the bridge. Ranks above context. */
  PATH: 1024,
  /**
   * THE BOUNDED BODY THE CURRENT RUNG SITS INSIDE — the page, not a place on it.
   *
   * Set on the parent document at the passage rung. Its declared boundary is
   * drawn unconditionally and its capital is suppressed, because at that
   * altitude the document is not one more mark competing with its own spans, it
   * is the edge they lie within. This is the flag that turns "five dots on a
   * void" into "five spans inside one document".
   */
  ENCLOSURE: 2048,
});

export const POINT_VERT = /* glsl */ `
${CAMERA_GLSL}
${RAMP_GLSL}
${HUE_GLSL}
${FLAGS_GLSL}

attribute vec2 aPos;      // baked world position
attribute float aRadius;  // baked radius, world units (containment radius for regions)
attribute float aLod;     // CONTINUOUS position on the resolution ramp, 0..4
attribute float aFlags;   // NODE_FLAG bitfield, packed in a float
attribute vec2 aMeta;     // (community hue index, centrality 0..1)

uniform vec3 uInk;
uniform vec3 uRender;
uniform vec3 uAlarm;
uniform float uDotMin;      // CSS px, --node-dot-min
uniform float uDotMax;      // CSS px, --node-dot-max
uniform float uCapital;     // CSS px, --node-capital
uniform vec2 uBody;         // CSS px, (--node-body-min, --node-body-max)
uniform float uAnswer;      // CSS px, --node-answer
uniform float uPath;        // CSS px, --node-path
uniform float uBodyNorm;    // world radius of the biggest body at this rung
uniform float uGlowCeiling; // CSS px, --lod-0-glow. A HARD CAP.
uniform float uGhostBlur;   // CSS px, --ghost-blur
uniform float uDim;         // fog of war during a query render, 0..1
uniform float uFogDemote;   // --fog-demote: ramp STEPS an unattended node drops
uniform float uRecede;      // how hard the rungs BELOW this one pull back, 0..1

varying vec2 vQuad;
varying vec4 vGeom;   // (quadHalfPx, ringPx, dotPx, strokePx)
varying vec4 vLight;  // (glowPx, glowAmount, softPx, ringOn)
varying vec4 vFill;   // premultiply-ready fill colour + alpha
varying vec4 vRim;    // boundary colour + alpha
varying vec4 vAux;    // (glow colour rgb, marks: +1 bridge, +2 quarantined)

void main() {
  bool isRegion  = hasFlag(aFlags, 32.0);
  bool selected  = hasFlag(aFlags, 1.0);
  bool hovered   = hasFlag(aFlags, 2.0);
  bool bridge    = hasFlag(aFlags, 4.0);
  bool quar      = hasFlag(aFlags, 8.0);
  bool constel   = hasFlag(aFlags, 16.0);
  bool focused   = hasFlag(aFlags, 64.0);
  bool wantsRing = hasFlag(aFlags, 128.0);
  bool primary   = hasFlag(aFlags, 256.0);
  bool answer    = hasFlag(aFlags, 512.0);
  bool path      = hasFlag(aFlags, 1024.0);
  bool enclosure = hasFlag(aFlags, 2048.0);

  /* FOG DEMOTES ALONG THE RAMP. It does not multiply by an invented constant.
   *
   * Multiplying was the bug: ghost (28%) times 0.16 is 4.5% of nothing, so the
   * peripheral world did not "remain as ghost context", it left — and the answer
   * ended up floating in empty water with no way to see which islands it spanned.
   * Dropping ONE RAMP STEP is the same statement said in the ramp's own units,
   * and latent (12%) is its floor, which is precisely the guarantee that
   * nothing relevant ever fully disappears.
   *
   * The whole node follows the demoted tier — opacity, stroke, glow, size and
   * softness — so a fogged node is drawn exactly like a node the engine admitted
   * one tier lower, rather than like a node someone turned down. */
  bool attended = selected || focused || answer || path || constel;
  float lod = attended ? aLod : min(4.0, aLod + uFogDemote * uDim);

  float opacity = rampOpacity(lod);
  float strokePx = cssPx(rampStroke(lod));
  float glowPx   = cssPx(rampGlow(lod));

  // ---- geometry ----------------------------------------------------------
  float worldPx = aRadius * uCam.z;
  float dotPx;
  float ringPx;
  float ringOn;
  float halo = 0.0;   // the primary body's outer shelf ring

  /* HOW BIG A REGION IS RELATIVE TO ITS PEERS AT THIS RUNG.
   *
   * From aRadius against a per-scene maximum, NOT from a ratio baked into the
   * instance buffer. Two reasons, and the second one is a bug this cost a while
   * to find: the peer set is a property of the RUNG YOU ARE STANDING ON, which
   * the bake cannot know; and the second component of aMeta never survived the
   * trip to the vertex shader, so every expression that read it produced a
   * non-finite size and REGION NODES HAVE NEVER BEEN DRAWN AT ALL. Every dot a
   * reader has ever seen next to an island name was the DOM label's own glyph.
   * The capitals, and with them the whole "a continent is a place" reading, were
   * silently absent from the terrain. */
  float rel = clamp(aRadius / max(uBodyNorm, 1e-3), 0.0, 1.0);

  if (isRegion) {
    // THE RUNG'S OWN BODIES ARE THE SUBJECT OF THE SCREEN. A continent seen from
    // the continent rung is a mass sized by how much of the world it holds, not
    // a 2.6px dot with a name beside it. Everything else keeps the capital,
    // which is what makes descending a change of ontology rather than of scale.
    dotPx = primary
      ? mix(uBody.x, uBody.y, rel) * uDpr
      : cssPx(uCapital) * (0.7 + 0.9 * rel);
    halo = primary ? 1.0 : 0.0;
    ringPx = worldPx;
    // Boundaries are earned. See NODE_FLAG.RING.
    ringOn = wantsRing ? 1.0 - smoothstep(2.0, 3.0, lod) : 0.0;
    /* THE ENCLOSURE IS THE PAGE, AND A PAGE IS AN EDGE, NOT A DOT.
     *
     * At the passage rung the document you descended into is not one more mark
     * competing with its own spans — it is the bounded body they lie inside, and
     * the honest glyph for a declared boundary is the boundary alone. So its
     * capital is suppressed, its ring is unconditional, and the ceiling that
     * hides an over-wide boundary is lifted: this one is meant to be bigger than
     * the frame's subject, because it CONTAINS the frame's subject. */
    if (enclosure) {
      ringOn = 1.0;
      dotPx = 0.0;
    } else if (ringPx > min(uViewport.x, uViewport.y) * 0.46) {
      // A boundary wider than the viewport has no readable arc and costs real
      // fill rate: past that point you are inside the region, not looking at it.
      ringOn = 0.0;
    }
    if (ringOn < 0.01) ringPx = dotPx;
  } else {
    // Resolution costs SIZE as well as opacity. A node the engine did not spend
    // on should not occupy the same area as one it did — at the island rung the
    // entity layer is latent, and twelve hundred full-size outline rings turn
    // every landmass into bubble wrap. Shrinking with the ramp makes the same
    // topology read as grain, which is what unspent topology should look like.
    float sizeScale = mix(1.0, 0.5, smoothstep(1.8, 4.0, lod));
    // The ceiling drops with the ramp too. Zoomed into one asset, the rest of
    // the world is closer to the camera and its leaves would all clamp to the
    // same maximum disc — the periphery would stop being periphery and the
    // screen would go back to being a scatter plot of equal dots.
    float maxPx = cssPx(uDotMax) * mix(1.0, 0.24, smoothstep(1.0, 4.0, lod));
    dotPx  = clamp(worldPx * sizeScale, cssPx(uDotMin), max(maxPx, cssPx(uDotMin)));
    /* A LEAF AT ITS OWN RUNG IS A BODY TOO, AND ITS SIZE IS ITS EXTENT.
     *
     * A passage seen from the passage rung is the subject of the screen, not
     * grain — and unlike an entity it has a real measured size: the span of
     * source it covers. Sizing it across the same body range a region gets means
     * the marks on the reading spine carry the span lengths the rail is already
     * printing, so the map and the rail state one fact once. */
    if (primary) { dotPx = max(dotPx, mix(uBody.x, uBody.y, rel) * uDpr); halo = 1.0; }
    ringPx = dotPx;
    ringOn = 0.0;
  }

  /* RANK, IN SIZE, ALONG THE ANSWER PATH.
   *
   * Every leaf disc is clamped by --node-dot-max, so at a query render the
   * answer, the bridge and twenty-three context entities were all drawn at
   * exactly the same nine pixels and the frame had no subject. The path core
   * clears that ceiling; the answer clears the path core.
   *
   *   answer  >  bridge / hop endpoints  >  constellation context
   */
  if (path && !answer) {
    dotPx = max(dotPx, cssPx(uPath));
    ringPx = dotPx;
    ringOn = 0.0;
    halo = 1.0;
  }
  if (answer) {
    dotPx = max(dotPx, cssPx(uAnswer));
    ringPx = dotPx;
    ringOn = 0.0;
    halo = 1.0;
  }

  float rEdge = mix(dotPx, ringPx, ringOn);

  // Selection earns the glow ceiling even when the node is not at the fovea.
  if (selected || focused || answer || path) glowPx = max(glowPx, cssPx(uGlowCeiling));
  float glowAmt = (glowPx > 0.0 ? clamp(glowPx / max(cssPx(uGlowCeiling), 1.0), 0.0, 1.0) : 0.0);

  // ---- the ramp's own softness. Ghost is blurred by --ghost-blur, nothing else.
  float ghostness = smoothstep(2.4, 3.4, lod);
  float softPx = cssPx(0.55 + uGhostBlur * ghostness);

  // ---- colour ------------------------------------------------------------
  vec3 baseHue = hueFamily(aMeta.x);
  /* THE RENDER LIGHT IS NOT A MEMBERSHIP BADGE.
   *
   * Constellation membership used to be worth 0.72 of the accent, which put
   * twenty-odd teal marks on the map around a two-hop answer and left the answer
   * with no way to be the teal thing. Teal marks the RENDERED PATH, the active
   * selection and the render control — nothing else — so a context member keeps
   * its own community hue and earns its presence by not being fogged, which is
   * the true statement about it: the engine looked here, and spent nothing. */
  float attention = max(selected || focused || answer ? 1.0 : 0.0, hovered ? 0.55 : 0.0);
  vec3 accent = quar ? uAlarm : uRender;

  // A primary body is bright INK carrying its region's hue, not a hue wash: the
  // rung's own bodies have to be the brightest thing on the ground they sit on.
  // A constellation member gets a smaller lift of the SAME ink, never the accent.
  vec3 bodyCol = mix(baseHue, uInk, primary ? 0.34 : (constel ? 0.24 : 0.10));
  // The boundary is where a node's own colour is strongest; the body is a wash of
  // it. That is what makes eight hues coexist without any of them shouting.
  vec3 rimCol  = mix(bodyCol, accent, attention);
  // ...except ON the answer path, where the node is not a place carrying a hue,
  // it is a step in a claim the engine is making. A violet disc with a thin teal
  // rim reads as "an entity that happens to be lit"; the answer has to read as
  // the answer, so its body IS the render light.
  float lit = answer ? 0.86 : (path ? 0.55 : attention * 0.30);
  vec3 fillCol = mix(mix(baseHue, uInk, primary ? 0.22 : (constel ? 0.14 : 0.0)), accent, lit);

  // THE RUNGS BELOW THIS ONE PULL BACK. Standing on the continent rung, the
  // 4,406 leaves of the world are texture, not subject; standing on an asset,
  // they are the point. Without this the same point cloud reads identically at
  // every altitude and zoom changes nothing but the labels.
  float below = smoothstep(2.2, 3.6, lod);
  float keep = mix(1.0, mix(1.0, 0.42, uRecede), below);
  float alpha = opacity * keep;

  /* THE RUNG YOU ARE STANDING ON IS DRAWN AT FULL RESOLUTION BY DEFINITION, and
   * so is the answer path. Both are floors, not overrides: the ramp still
   * decides everything else, and a body that the ramp already puts higher keeps
   * its own value. Without the floor a body inherits whatever tier the ambient
   * map happened to leave it at, which is how the subject of a screen ends up
   * drawn at a resolution that means "the engine did not spend on this". */
  if (primary) alpha = max(alpha, rampOpacity(1.0));
  if (path || answer) alpha = max(alpha, rampOpacity(0.0));

  // latent is OUTLINE ONLY. The far end of the ramp does not get a body.
  float fillAmount = 1.0 - smoothstep(3.05, 4.0, lod);
  // ...except below about two pixels, where an outline is not a thing that can
  // be drawn: a 1px stroke on a 1.2px disc is a donut, and four thousand donuts
  // is a texture the data does not have. Under that size the ramp degrades to a
  // dimmer dot, which is the same information at a size the screen can carry.
  fillAmount = max(fillAmount, 1.0 - smoothstep(1.3, 2.4, dotPx / max(uDpr, 0.5)));
  // A primary body is FILLED — it is the subject, not an enclosure.
  if (primary || answer || path) fillAmount = 1.0;
  // A region's interior belongs to the wash layer, so only its capital is filled.
  float fillA = alpha * fillAmount * (isRegion ? 1.0 : 0.85);
  // A containment boundary is a hairline, not a stroke. It has to be readable
  // as an enclosure without competing with the nodes it encloses.
  float rimA  = alpha * mix(0.5, 1.0, min(1.0, attention + 0.5)) * mix(1.0, 0.55, ringOn);
  /* ...unless the boundary IS the frame. The page edge at the passage rung has
   * to be found by the eye at a radius of several hundred pixels, and a hairline
   * at a third of its own opacity is not found: it was drawn and it was not
   * seen, which is the same outcome as not drawing it. Ink, at full rim weight,
   * because at that altitude the enclosure is structure rather than one more
   * region competing with its neighbours. */
  if (enclosure) {
    rimCol = mix(rimCol, uInk, 0.55);
    rimA = alpha;
  }

  // ---- placement ---------------------------------------------------------
  float haloPx = halo > 0.5 ? dotPx * 0.62 : 0.0;
  float halfPx = max(rEdge, dotPx) + haloPx + strokePx * 3.0 + glowPx + softPx + cssPx(1.0);
  vec2 sc = worldToScreen(aPos);

  if (alpha < 0.004 || offscreen(sc, halfPx)) {
    gl_Position = cullVertex();
    return;
  }

  vQuad  = position.xy;
  vGeom  = vec4(halfPx, ringPx, dotPx, strokePx);
  vLight = vec4(glowPx, glowAmt * alpha * 0.55, softPx, ringOn);
  vFill  = vec4(fillCol, fillA);
  vRim   = vec4(rimCol, rimA);
  vAux   = vec4(accent, (bridge ? 1.0 : 0.0) + (quar ? 2.0 : 0.0) + (halo > 0.5 ? 4.0 : 0.0));

  gl_Position = screenToClip(sc + position.xy * halfPx);
}
`;

export const POINT_FRAG = /* glsl */ `
varying vec2 vQuad;
varying vec4 vGeom;
varying vec4 vLight;
varying vec4 vFill;
varying vec4 vRim;
varying vec4 vAux;

void main() {
  float halfPx = vGeom.x;
  float ringPx = vGeom.y;
  float dotPx  = vGeom.z;
  float stroke = max(vGeom.w, 0.55);
  float soft   = max(vLight.z, 0.55);
  float ringOn = vLight.w;

  float dp = length(vQuad) * halfPx;
  float rEdge = mix(dotPx, ringPx, ringOn);

  vec3 rgb = vec3(0.0);
  float a = 0.0;

  // ---- body ---------------------------------------------------------------
  float disc = 1.0 - smoothstep(dotPx - soft, dotPx + soft * 0.8, dp);
  float fa = disc * vFill.a;
  rgb += vFill.rgb * fa;
  a += fa;

  // ---- boundary -----------------------------------------------------------
  float ring = exp(-pow((dp - rEdge) / stroke, 2.0));

  // marks is a three-bit field: 1 bridge, 2 quarantined, 4 primary/answer halo.
  float marks = vAux.w;
  float bridge = mod(marks, 2.0);
  float quar   = mod(floor(marks / 2.0), 2.0);
  float halo   = mod(floor(marks / 4.0), 2.0);

  // A quarantined boundary is drawn BROKEN and it does not close. The truth gate
  // refusing to admit what it cannot substantiate is a feature, so it is SHOWN.
  float ang = atan(vQuad.y, vQuad.x);
  ring *= mix(1.0, step(0.34, fract(ang * 2.8656)), quar);

  float ra = ring * vRim.a;
  rgb = rgb * (1.0 - ra) + vRim.rgb * ra;
  a   = a   * (1.0 - ra) + ra;

  // ---- the body's own shelf ------------------------------------------------
  // A body of the current rung is a MASS, not a dot: a soft ring just outside it
  // gives it a shoreline of its own, so at the continent rung six continents read
  // as six places rather than as six pixels on a field of assets.
  if (halo > 0.5) {
    float shelf = exp(-pow((dp - dotPx * 1.34) / max(stroke * 2.2, 1.0), 2.0)) * vRim.a * 0.42;
    rgb = rgb * (1.0 - shelf) + vRim.rgb * shelf;
    a   = a   * (1.0 - shelf) + shelf;
  }

  // ---- the bridge collar --------------------------------------------------
  // A bridge entity spans two islands. It does not get a new colour — it gets a
  // second boundary, because that is literally what it has.
  if (bridge > 0.5) {
    float collar = exp(-pow((dp - rEdge - stroke * 2.8) / stroke, 2.0)) * vRim.a * 0.55;
    rgb = rgb * (1.0 - collar) + vRim.rgb * collar;
    a   = a   * (1.0 - collar) + collar;
  }

  // ---- glow: 6px screen-space falloff, earned. Never a bloom pass. ---------
  if (vLight.y > 0.0) {
    float g = exp(-max(dp - rEdge, 0.0) / max(vLight.x, 0.5)) * vLight.y;
    rgb += vAux.rgb * g;
    a = max(a, g * 0.6);
  }

  if (a < 0.0035) discard;
  gl_FragColor = vec4(rgb, a);
}
`;
