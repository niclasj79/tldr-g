/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — SHARED GLSL
 * =============================================================================
 *
 * ZERO COLOUR LITERALS LIVE IN ANY SHADER IN THIS DIRECTORY. Every colour
 * arrives as a uniform sourced from `design-tokens.css` through
 * `@/styles/tokens.ts` -> `@/graph/palette.ts`. If you are about to type a
 * number that is a colour into GLSL: stop, and add the token instead.
 *
 * -----------------------------------------------------------------------------
 * THE CAMERA IS A UNIFORM, NOT A MATRIX
 * -----------------------------------------------------------------------------
 * Every layer transforms world -> DEVICE PIXELS -> clip by hand rather than
 * going through `projectionMatrix * modelViewMatrix`. That is not a shortcut, it
 * is the requirement: this is a top-down orthographic instrument whose stroke
 * widths, glow radii, dash periods and label offsets are all specified in CSS
 * pixels by the design tokens. Working in pixel space means "1.5px stroke" is
 * literally 1.5 device-pixels-over-DPR in the fragment shader, at any zoom, in
 * every layer, and the JS side (`camera.worldToScreen`) uses the identical
 * expression, so the DOM label layer lands exactly on the WebGL node.
 *
 * `uCam` is `(cameraX, cameraY, pixelsPerWorldUnit)` where the third component
 * is already multiplied by the device pixel ratio. `uViewport` is the drawing
 * buffer size in device pixels. Y is UP in world, screen and clip space alike —
 * there is no flip anywhere in this renderer.
 * ========================================================================== */

/** World -> device-pixel -> clip, plus the pixel-space helpers every layer uses. */
export const CAMERA_GLSL = /* glsl */ `
uniform vec3 uCam;        // (camX, camY, devicePixelsPerWorldUnit)
uniform vec2 uViewport;   // drawing buffer size, device px
uniform float uDpr;       // device pixels per CSS pixel

vec2 worldToScreen(vec2 w) { return (w - uCam.xy) * uCam.z + uViewport * 0.5; }
vec4 screenToClip(vec2 s)  { return vec4(s / uViewport * 2.0 - 1.0, 0.0, 1.0); }

/** CSS px -> device px. Every token length goes through this exactly once. */
float cssPx(float v) { return v * uDpr; }

/** Push a vertex outside the clip volume. A vertex-side cull with no fragment cost. */
vec4 cullVertex() { return vec4(0.0, 0.0, 2.0, 1.0); }

/** True when a screen-space AABB of half-size h around c misses the viewport. */
bool offscreen(vec2 c, float h) {
  return c.x + h < 0.0 || c.x - h > uViewport.x || c.y + h < 0.0 || c.y - h > uViewport.y;
}
`;

/**
 * The resolution ramp, evaluated in the shader.
 *
 * `uLodOpacity/uLodStroke/uLodGlow` are the five authored ramp states from
 * design-tokens.css §7. The LOD attribute is a CONTINUOUS scalar, not an enum,
 * which is the whole point: when the engine re-admits a node at a different
 * resolution the value slides between two ramp states and the node crossfades
 * through the ramp instead of popping. A pop would read as a glitch; a crossfade
 * reads as the renderer changing its mind, which is what actually happened.
 */
export const RAMP_GLSL = /* glsl */ `
uniform float uLodOpacity[5];
uniform float uLodStroke[5];
uniform float uLodGlow[5];

// Constant-index reads only. Dynamic indexing of a uniform array is a
// portability risk that fails as a silently wrong colour rather than as a
// compile error, and a ramp that lies about resolution is the one bug this
// renderer cannot ship.
float pick5(float v0, float v1, float v2, float v3, float v4, float lod) {
  float c = clamp(lod, 0.0, 4.0);
  float i = floor(c);
  float f = c - i;
  float a = v0;
  if (i > 0.5) a = v1;
  if (i > 1.5) a = v2;
  if (i > 2.5) a = v3;
  if (i > 3.5) a = v4;
  float b = v1;
  if (i > 0.5) b = v2;
  if (i > 1.5) b = v3;
  if (i > 2.5) b = v4;
  return mix(a, b, f);
}

float rampOpacity(float lod) {
  return pick5(uLodOpacity[0], uLodOpacity[1], uLodOpacity[2], uLodOpacity[3], uLodOpacity[4], lod);
}
float rampStroke(float lod) {
  return pick5(uLodStroke[0], uLodStroke[1], uLodStroke[2], uLodStroke[3], uLodStroke[4], lod);
}
float rampGlow(float lod) {
  return pick5(uLodGlow[0], uLodGlow[1], uLodGlow[2], uLodGlow[3], uLodGlow[4], lod);
}
`;

/** A cheap, stable value hash. Used for dithering only — never for geometry. */
export const HASH_GLSL = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
`;

/**
 * The eight community hue families, addressed by index.
 *
 * WebGL1 cannot index a uniform array with a non-constant expression in a
 * fragment shader, and even in the vertex shader dynamic indexing is a portability
 * risk on older drivers. So the lookup is an unrolled select. Eight comparisons
 * is nothing; a driver-specific miscompile that silently paints every community
 * the same colour would destroy the one property the palette exists to provide.
 */
export const HUE_GLSL = /* glsl */ `
uniform vec3 uHue[8];

vec3 hueFamily(float idx) {
  int i = int(idx + 0.5);
  if (i == 0) return uHue[0];
  if (i == 1) return uHue[1];
  if (i == 2) return uHue[2];
  if (i == 3) return uHue[3];
  if (i == 4) return uHue[4];
  if (i == 5) return uHue[5];
  if (i == 6) return uHue[6];
  return uHue[7];
}
`;

/** Bit test on a float-packed flag field. Values stay well inside 2^24. */
export const FLAGS_GLSL = /* glsl */ `
bool hasFlag(float packed, float bit) {
  return mod(floor(packed / bit), 2.0) >= 0.5;
}
`;
