/**
 * portExtension.js
 * Applies a port-extension electrical delay to S-parameter data.
 *
 * A port extension shifts the reference plane by adding electrical delay:
 *   τ = 2 · length / v_phase   (2-way travel time)
 *   v_phase = c / √εeff
 *
 * Each frequency point's S11 phase is rotated by −2βℓ where β = 2πf√εeff/c.
 */

import { speedOfLight, polarToRectangular, rectangularToPolar } from "./commonFunctions.js";

/**
 * Apply port extension to a single S11 rectangular value.
 * De-embeds a transmission line of electrical length ℓ by rotating the
 * reflection coefficient forward: Γ_extended = Γ · e^{+2jβℓ}.
 * This recovers Γ_L from the measured Γ_in = Γ_L · e^{−2jβℓ}.
 *
 * @param {{real:number,imaginary:number}} s11rect - S11 in rectangular form
 * @param {number} f - frequency in Hz
 * @param {number} length - extension length in metres
 * @param {number} eeff - effective dielectric constant (default 1)
 * @returns {{real:number,imaginary:number}} de-embedded S11
 */
export function applyPortExtensionSingle(s11rect, f, length, eeff = 1) {
  const beta = (2 * Math.PI * f * Math.sqrt(eeff)) / speedOfLight;
  const theta = 2 * beta * length; // two-way phase shift
  const cos_t = Math.cos(theta);  // corrected: e^{+j2βl} de-embeds the reference plane
  const sin_t = Math.sin(theta);
  return {
    real: s11rect.real * cos_t - s11rect.imaginary * sin_t,
    imaginary: s11rect.real * sin_t + s11rect.imaginary * cos_t,
  };
}

/**
 * Apply port extension to a full frequency-keyed s-param data object.
 * Modifies only S11 (1-port extension). For S21/S22 a 2-port extension would
 * require separate per-port delays; this implementation covers the common
 * 1-port (reflection) case used in teaching.
 *
 * @param {Object} sparamData - frequency-keyed s-param data
 * @param {number} length - extension length in metres
 * @param {number} eeff - effective dielectric constant
 * @returns {Object} new frequency-keyed s-param data with S11 phase-shifted
 */
export function applyPortExtension(sparamData, length, eeff = 1) {
  if (!length || length === 0) return sparamData;
  const result = {};
  for (const fStr in sparamData) {
    const f = Number(fStr);
    const point = sparamData[fStr];
    const s11Rect = polarToRectangular(point.S11);
    const extended = applyPortExtensionSingle(s11Rect, f, length, eeff);
    const extendedPolar = rectangularToPolar(extended);
    result[fStr] = { ...point, S11: extendedPolar };
  }
  return result;
}

/**
 * Compute the two-way time delay (seconds) for a given extension length and εeff.
 *
 * @param {number} length - metres
 * @param {number} eeff - effective dielectric constant
 * @returns {number} delay in seconds
 */
export function extensionDelay(length, eeff = 1) {
  return (2 * length * Math.sqrt(eeff)) / speedOfLight;
}
