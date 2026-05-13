/**
 * uncertaintyRender.js
 *
 * Shared helpers for rendering the VNA measurement uncertainty region on a
 * Smith chart.  The region is computed in the complex reflection-coefficient
 * (Γ) plane — a circle of radius δΓ centred on each S11 point — and then
 * mapped through the nonlinear Smith chart transformation so that it appears
 * as an ellipse (single frequency) or a filled tube (frequency sweep).
 */

import { reflToZ } from "./commonFunctions.js";

// ---------------------------------------------------------------------------
// Rendering constants
// ---------------------------------------------------------------------------

/** Number of vertices used to approximate the full circle (single-point case). */
export const UNCERTAINTY_CIRCLE_SAMPLES = 36;

/** Number of intermediate vertices in each semicircular end cap. */
export const UNCERTAINTY_CAP_SAMPLES = 8;

/** SVG fill colour for the uncertainty region. */
export const UNCERTAINTY_FILL = "rgba(200,100,0,0.15)";

/** SVG stroke colour for the uncertainty region boundary. */
export const UNCERTAINTY_STROKE = "rgba(200,100,0,0.75)";

/** Points this close to or beyond the unit circle boundary are excluded. */
const UNIT_CIRCLE_TOLERANCE = 1e-6;

/** Uncertainty radii smaller than this are treated as zero and ignored. */
const MIN_DRAWABLE_UNCERTAINTY = 1e-9;

// ---------------------------------------------------------------------------
// Internal coordinate helper
// ---------------------------------------------------------------------------

/** Smith-chart coordinate transform — matches the formula used in Graph.jsx / VnaSmithChart.jsx. */
function _impedanceToSmithXY(re, im, width) {
  const a = 1 / (1 + re);
  const b = 1 / im;
  let x, y;
  if (im === 0) {
    x = -2 * a;
    y = 0;
  } else {
    x = (-2 * a * b * b) / (a * a + b * b);
    y = (2 * a * a * b) / (a * a + b * b);
  }
  return [Number((x * width * 0.5).toFixed(1)), Number((y * width * 0.5).toFixed(1))];
}

// ---------------------------------------------------------------------------
// Exported helpers
// ---------------------------------------------------------------------------

/**
 * Convert Γ = (gr, gi) to Smith chart pixel coords [x, y].
 * Returns null when the point lies on or outside the unit circle boundary.
 *
 * @param {number} gr      - real part of Γ
 * @param {number} gi      - imaginary part of Γ
 * @param {number} refZo   - characteristic impedance used for Γ → Z conversion (Ω)
 * @param {number} displayZo - normalisation impedance for the Smith chart (Ω)
 * @param {number} width   - Smith chart pixel width
 * @returns {[number,number]|null}
 */
export function gammaToSmithXY(gr, gi, refZo, displayZo, width) {
  if (gr * gr + gi * gi >= 1 - UNIT_CIRCLE_TOLERANCE) return null;
  const z = reflToZ({ real: gr, imaginary: gi }, refZo);
  return _impedanceToSmithXY(z.real / displayZo, z.imaginary / displayZo, width);
}

/**
 * Sample a semicircular arc of the uncertainty circle in Γ-space, going from
 * `fromG` to `toG` along the arc that passes through `throughAngle`.
 *
 * @param {{gr:number,gi:number}} center - Γ-plane centre of the circle
 * @param {number}  radius       - circle radius (δΓ)
 * @param {{gr:number,gi:number}} fromG  - start point on the circle
 * @param {{gr:number,gi:number}} toG    - end point on the circle
 * @param {number}  throughAngle - angle (radians) that the arc must pass through
 * @param {number}  refZo        - characteristic impedance (Ω)
 * @param {number}  displayZo    - Smith chart normalisation impedance (Ω)
 * @param {number}  width        - Smith chart pixel width
 * @returns {Array<[number,number]>} - pixel coords (null entries excluded)
 */
export function sampleUncertaintyArc(center, radius, fromG, toG, throughAngle, refZo, displayZo, width) {
  const fromAngle = Math.atan2(fromG.gi - center.gi, fromG.gr - center.gr);
  const toAngle = Math.atan2(toG.gi - center.gi, toG.gr - center.gr);
  const norm = (a) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const fa = norm(fromAngle);
  const ta = norm(toAngle);
  const wa = norm(throughAngle);
  const ccwFaToTa = (ta - fa + 2 * Math.PI) % (2 * Math.PI);
  const ccwFaToWa = (wa - fa + 2 * Math.PI) % (2 * Math.PI);
  const span = ccwFaToWa < ccwFaToTa ? ccwFaToTa : -(2 * Math.PI - ccwFaToTa);
  const result = [];
  for (let k = 1; k < UNCERTAINTY_CAP_SAMPLES; k++) {
    const theta = fromAngle + (span * k) / UNCERTAINTY_CAP_SAMPLES;
    const xy = gammaToSmithXY(center.gr + radius * Math.cos(theta), center.gi + radius * Math.sin(theta), refZo, displayZo, width);
    if (xy) result.push(xy);
  }
  return result;
}

/**
 * Build the SVG path string that outlines the uncertainty region for a set of
 * S11 measurement points.
 *
 * For a **single frequency** the region is a circle in Γ-space (δΓ radius),
 * which maps to an ellipse on the Smith chart.
 *
 * For a **frequency sweep** the region is a tube formed by perpendicular
 * offsets of the S11 trace in Γ-space, closed by semicircular end caps.
 *
 * @param {Array<{gr:number, gi:number, dG:number}>} pts - Γ-plane centre and
 *   radius for each frequency point
 * @param {number} refZo     - characteristic impedance (Ω)
 * @param {number} displayZo - Smith chart normalisation impedance (Ω)
 * @param {number} width     - Smith chart pixel width
 * @returns {string|null} SVG path `d` attribute, or null if nothing drawable
 */
export function buildUncertaintyPathStr(pts, refZo, displayZo, width) {
  const valid = pts.filter((p) => p.dG > MIN_DRAWABLE_UNCERTAINTY);
  if (valid.length === 0) return null;
  const toXY = (gr, gi) => gammaToSmithXY(gr, gi, refZo, displayZo, width);

  if (valid.length === 1) {
    // Single point: full circle in Γ-plane → ellipse on Smith chart
    const { gr, gi, dG } = valid[0];
    const coords = [];
    for (let k = 0; k <= UNCERTAINTY_CIRCLE_SAMPLES; k++) {
      const theta = (2 * Math.PI * k) / UNCERTAINTY_CIRCLE_SAMPLES;
      const xy = toXY(gr + dG * Math.cos(theta), gi + dG * Math.sin(theta));
      if (xy) coords.push(xy);
    }
    if (coords.length < 3) return null;
    return `M ${coords[0][0]} ${coords[0][1]}` + coords.slice(1).map((c) => ` L ${c[0]} ${c[1]}`).join("") + " Z";
  }

  // Multiple points: perpendicular offsets in Γ-space form a tube
  const N = valid.length;
  const tangents = valid.map((p, i) => {
    const prev = valid[Math.max(0, i - 1)];
    const next = valid[Math.min(N - 1, i + 1)];
    const dx = next.gr - prev.gr;
    const dy = next.gi - prev.gi;
    const len = Math.hypot(dx, dy) || 1;
    return { tx: dx / len, ty: dy / len };
  });
  // Upper side: rotate tangent +90° → perp = (-ty, tx)
  const upperG = valid.map((p, i) => ({ gr: p.gr - tangents[i].ty * p.dG, gi: p.gi + tangents[i].tx * p.dG }));
  // Lower side: rotate tangent −90° → perp = (ty, -tx)
  const lowerG = valid.map((p, i) => ({ gr: p.gr + tangents[i].ty * p.dG, gi: p.gi - tangents[i].tx * p.dG }));

  const upperXY = upperG.map((g) => toXY(g.gr, g.gi));
  const lowerXY = lowerG.map((g) => toXY(g.gr, g.gi));

  // Semicircular end caps
  const startCap = sampleUncertaintyArc(
    valid[0], valid[0].dG, lowerG[0], upperG[0],
    Math.atan2(-tangents[0].ty, -tangents[0].tx), refZo, displayZo, width,
  );
  const endCap = sampleUncertaintyArc(
    valid[N - 1], valid[N - 1].dG, upperG[N - 1], lowerG[N - 1],
    Math.atan2(tangents[N - 1].ty, tangents[N - 1].tx), refZo, displayZo, width,
  );

  // Closed path: upper → end-cap → lower (reversed) → start-cap
  const allCoords = [
    ...upperXY.filter(Boolean),
    ...endCap,
    ...[...lowerXY.filter(Boolean)].reverse(),
    ...startCap,
  ];
  if (allCoords.length < 3) return null;
  return `M ${allCoords[0][0]} ${allCoords[0][1]}` + allCoords.slice(1).map((c) => ` L ${c[0]} ${c[1]}`).join("") + " Z";
}
