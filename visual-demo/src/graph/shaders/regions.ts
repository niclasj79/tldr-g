/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE REGION WASH (the land itself)
 * =============================================================================
 *
 * This is the layer that decides whether the terrain reads as GEOGRAPHY or as a
 * scatter plot, and the difference is entirely in how the community field is
 * shaped.
 *
 * NOT convex hulls with hard outlines: a hull says "these points are in a set",
 * which is a Venn diagram, and Venn diagrams are about membership, not place.
 * NOT a Voronoi partition: a partition claims every square inch of the plane
 * belongs to somebody, and the honest thing about a knowledge terrain is that
 * most of the plane is EMPTY. There is no data there and the map must say so.
 *
 * Instead the layer samples a smooth density field baked from where the assets
 * and passages actually are (see `@/graph/regions.ts`), and derives:
 *
 *   land   — density above the coast threshold, carrying the community hue at
 *            `--wash-continent` strength. Denser cores are slightly brighter, so
 *            a landmass has interior mass rather than being a flat sticker.
 *   shore  — a narrow band at the threshold. Coastlines are where the eye locks
 *            on; without one, land fades into void and every continent looks
 *            like a smudge with no edge.
 *   shallows — a band of water hugging the coast, below the threshold. This is
 *            what makes a STRAIT read as a channel with a bank on each side
 *            rather than as an accidental gap between two stickers.
 *   seam   — where two communities meet INSIDE one landmass. A continent made of
 *            five islands should show the join, or it is one flat sticker again.
 *   void   — nothing at all. Discarded, not painted dark.
 *
 * -----------------------------------------------------------------------------
 * THE COASTLINE IS MEASURED IN SCREEN PIXELS
 * -----------------------------------------------------------------------------
 * The transition width used to be a fixed interval in DENSITY, which means its
 * width on the display was whatever the zoom happened to make it: a crisp edge
 * at the world rung and a several-hundred-pixel gradient once you approached.
 * Zooming in removed resolution — the exact opposite of what an atlas is for,
 * and how a map turns into wallpaper.
 *
 * So the shader estimates |grad d| from four neighbour taps, converts it into
 * "density units per display pixel", and sets the transition to `--coast-px`
 * pixels wide. The coast is the same crisp line at every altitude.
 *
 * And when the field is magnified past `--field-texel-max` — one texel covering
 * more display pixels than it has information for — the wash FADES OUT. Below
 * its own resolution the field has nothing to say, and saying nothing is the
 * only honest option. A flat full-bleed colour field is not terrain.
 * ========================================================================== */

import { CAMERA_GLSL, HASH_GLSL } from '@/graph/shaders/common';

/** Discs the "you are here" mask may carry. One per body of the current rung. */
export const REGION_FOCUS_MAX = 8;

/**
 * Discs the LANDFALL mask may carry — the regions the answer path actually
 * stands on.
 *
 * Four, because a two-hop bridge answer touches at most three islands and the
 * fourth slot is headroom. More than that is not "where the answer is", it is
 * the map again.
 */
export const REGION_LANDFALL_MAX = 4;

export const REGION_VERT = /* glsl */ `
${CAMERA_GLSL}

varying vec2 vUv;
varying vec2 vWorld;

void main() {
  vUv = uv;
  vWorld = position.xy;
  gl_Position = screenToClip(worldToScreen(position.xy));
}
`;

export const REGION_FRAG = /* glsl */ `
${HASH_GLSL}

// The camera, again, on the fragment side: the coastline is derived in DISPLAY
// pixels, so this stage needs to know how many of them a world unit is worth.
uniform vec3 uCam;          // (camX, camY, devicePixelsPerWorldUnit)
uniform float uDpr;

uniform sampler2D uField;   // rgb = local community hue, a = fine density
uniform sampler2D uShelf;   // rgb = dominant hue FAMILY, a = the fused landmass
uniform vec2 uFieldStep;    // 1 / field size, in uv
uniform float uTexelWorld;  // world units per fine texel
uniform vec2 uCoast;    // (sea level, full land)
uniform float uCoastPx;     // --coast-px. Coastline width ON THE DISPLAY.
uniform float uTexelMaxPx;  // --field-texel-max. Past this the field is out of resolution.
uniform float uTexelFade;   // --field-texel-fade. The multiple at which it is fully gone.
uniform vec2 uMerge;    // (--field-merge-lift, --field-seam)
uniform float uWash;    // --wash-continent. The region wash is a CONTINENT-strength wash.
uniform float uGrain;   // --field-grain. Mottling amplitude; also carries the 8-bit dither.
uniform vec4 uFocus[${REGION_FOCUS_MAX}];  // (x, y, r, on) — the bodies of the current rung
uniform float uFocusN;
uniform float uFocusOut;    // --field-out-of-scope
uniform vec4 uLandfall[${REGION_LANDFALL_MAX}]; // (x, y, r, on) — where the answer stands
uniform float uLandfallN;
uniform float uFogSea;      // --fog-sea:        what the FILL keeps under fog
uniform float uFogCoast;    // --fog-coast-gain: what the COASTLINE gains under fog
uniform float uFogLandfall; // --fog-landfall:   what the answer's own ground keeps
uniform float uDim;

varying vec2 vUv;
varying vec2 vWorld;

/** The merged land height at a uv: the fine field, lifted by its family shelf. */
float landAt(vec2 uv) {
  return max(texture2D(uField, uv).a, texture2D(uShelf, uv).a * uMerge.x);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main() {
  // ---- is the field still saying anything at this magnification? ----------
  // One texel, in display pixels. Past --field-texel-max the wash is being
  // magnified past its own information content, so it recedes rather than
  // painting the screen a flat colour it never measured.
  float texelPx = uTexelWorld * uCam.z;
  float resolve = 1.0 - smoothstep(uTexelMaxPx * uDpr, uTexelMaxPx * uDpr * uTexelFade, texelPx);
  if (resolve <= 0.002) discard;

  vec4 f = texture2D(uField, vUv);
  vec4 s = texture2D(uShelf, vUv);
  // The land is the fine field lifted by its own family's shelf: two islands of
  // one continent share a coastline, two islands of different continents do not.
  float d = max(f.a, s.a * uMerge.x);
  if (d <= 0.004) discard;

  // ---- the coast, in screen space ----------------------------------------
  vec2 e = uFieldStep;
  float dL = landAt(vUv - vec2(e.x, 0.0));
  float dR = landAt(vUv + vec2(e.x, 0.0));
  float dD = landAt(vUv - vec2(0.0, e.y));
  float dU = landAt(vUv + vec2(0.0, e.y));
  // Density units per texel -> density units per display pixel.
  float gradTexel = length(vec2(dR - dL, dU - dD)) * 0.5;
  float perPx = gradTexel / max(texelPx, 0.0001);
  // The transition is --coast-px wide on the display, at every altitude, with a
  // floor so a perfectly flat interior does not divide by nothing.
  float band = max(perPx * uCoastPx * uDpr, 0.0035);

  float land  = smoothstep(uCoast.x - band, uCoast.x + band, d);
  // Shallows: water hugging the coast, also sized in screen space. In a strait
  // the two banks nearly touch, and the channel between them becomes readable
  // as a crossing instead of as an accidental gap.
  float shallow = smoothstep(uCoast.x - band * 9.0, uCoast.x - band, d) * (1.0 - land);
  // The shoreline itself: a thin isoline right at sea level. This is what turns
  // a soft field into a map.
  float shore = exp(-pow((d - uCoast.x) / max(band * 1.6, 0.002), 2.0));

  // Interior mass: the core of a landmass carries more of its hue than its rim,
  // so a continent has weight instead of being an outlined sticker. Widened,
  // because a set of equally-bright blobs is a petri dish and the whole point of
  // normalising each family separately is that mass should vary.
  float depth = 0.62 + 1.25 * smoothstep(uCoast.x, min(1.0, uCoast.y + 0.30), d);

  // ---- the internal seam --------------------------------------------------
  // Where the LOCAL community hue swings inside land, two communities are
  // meeting. That join is the difference between a continent made of islands
  // and one flat sticker, so it is drawn as low ground rather than smoothed out.
  vec3 hL = texture2D(uField, vUv - vec2(e.x, 0.0)).rgb;
  vec3 hR = texture2D(uField, vUv + vec2(e.x, 0.0)).rgb;
  vec3 hD = texture2D(uField, vUv - vec2(0.0, e.y)).rgb;
  vec3 hU = texture2D(uField, vUv + vec2(0.0, e.y)).rgb;
  float seam = clamp((length(hR - hL) + length(hU - hD)) * 1.6, 0.0, 1.0);
  // Isthmus: land the shelf made that the fine field did not. Low ground.
  float isthmus = clamp((d - f.a) / max(uCoast.y, 0.001), 0.0, 1.0);

  // The hue is the LOCAL community where the corpus actually is, and the family
  // hue out on the isthmus where only the shelf reaches. Same region either way;
  // the isthmus simply has no documents of its own to name it.
  vec3 hue = mix(f.rgb, s.rgb, smoothstep(0.10, 0.65, isthmus));

  /* WHERE THE ANSWER STANDS. The islands the rendered path actually touches,
   * as discs, so the fog can treat them differently from the rest of the sea.
   * Empty at rest, which is why this costs nothing when no answer is on screen. */
  float landfall = 0.0;
  if (uLandfallN > 0.5) {
    for (int i = 0; i < ${REGION_LANDFALL_MAX}; i++) {
      float on = step(float(i) + 0.5, uLandfallN);
      float r = max(uLandfall[i].z, 1e-3);
      // Tight against the region's own core. A containment radius is generous —
      // taking all of it lit two thirds of the terrain and "which islands does
      // this answer span" stopped having an answer again, from the other side.
      landfall = max(landfall, on * (1.0 - smoothstep(r * 0.45, r * 0.95, length(vWorld - uLandfall[i].xy))));
    }
  }

  // The shore is a HINT, not a highlight. An isoline bright enough to trace the
  // coast for you is neon, and neon is banned: it makes the map look drawn
  // rather than measured, and it steals attention the render light has to spend.
  /* FOG TAKES THE FILL AND LEAVES — RAISES — THE COASTLINE.
   *
   * Applied per term rather than to the total, because the two terms say
   * different things. Scaling the whole wash was what emptied the flagship
   * frame: at a 10% wash, 46% of it is a two-percent difference from the void,
   * so the answer floated in black water with no islands under it and the
   * STRAIT it crosses — the single best argument the product has — was not in
   * the picture at all.
   *
   * So under fog the interior SINKS to the ghost tier and the shoreline GAINS.
   * An unattended region stops being a filled mass and becomes a drawn outline,
   * which is what "the engine did not spend here, and it is still there" should
   * look like — and two outlines with dark water between them is a strait you
   * can watch a hop cross. The ground the answer actually stands on keeps its
   * fill (--fog-landfall), because which ground that is happens to be the
   * subject of the frame. */
  float fogFill = mix(1.0, mix(uFogSea, uFogLandfall, landfall), uDim);
  float fogEdge = mix(1.0, uFogCoast, uDim);
  // The shore and the shallows are ONE drawing — the line and the water that
  // hugs it — and they move together, because a coast with no shallows beside it
  // is an outline, not a shore, and a strait needs both banks and the channel.
  float a = uWash * (land * depth * fogFill + (shore * 0.50 + shallow * 0.26) * fogEdge);
  a *= 1.0 - uMerge.y * max(seam, isthmus * 0.75) * land;

  // World-locked mottling. Locked to WORLD coordinates, not screen, so it is a
  // property of the terrain and does not crawl when the camera moves.
  a *= 1.0 - uGrain * 0.26 * (vnoise(vWorld * 0.05) - 0.5) * 2.0;

  // "You are here." Not one disc around the parent — the union of the bodies of
  // the rung you are standing on, which is the land you actually descended into.
  // Everything outside them recedes, so descending is travel, not a label swap.
  if (uFocusN > 0.5) {
    float inside = 0.0;
    for (int i = 0; i < ${REGION_FOCUS_MAX}; i++) {
      float on = step(float(i) + 0.5, uFocusN);
      float r = max(uFocus[i].z, 1e-3);
      inside = max(inside, on * (1.0 - smoothstep(r * 0.85, r * 1.9, length(vWorld - uFocus[i].xy))));
    }
    a *= mix(uFocusOut, 1.0, inside);
  }

  a *= resolve;

  // A 10% wash on an 8-bit buffer bands. A band is a structure the data does not
  // have, so it is dithered away rather than left to look like a contour.
  a += (hash12(gl_FragCoord.xy) - 0.5) * (1.0 / 255.0) * (1.0 + uGrain * 8.0);
  a = clamp(a, 0.0, 1.0);
  if (a < 0.0025) discard;

  gl_FragColor = vec4(hue * a, a);
}
`;
