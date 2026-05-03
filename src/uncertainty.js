/**
 * uncertainty.js
 * VNA measurement uncertainty estimation.
 *
 * Sources of uncertainty modelled:
 *   1. Residual directivity (Ed) — post-calibration directivity error
 *   2. Residual source match (Es) — post-calibration source match error
 *   3. Residual reflection tracking (Et) — reflection tracking error
 *   4. Noise floor — minimum detectable Γ at each frequency
 *   5. Cable/connector repeatability — user-specified ±dB figure
 *
 * The worst-case (linear addition) bound on |Γ_corrected| is:
 *   δΓ = |Ed| + |Es|·|Γ_dut|² + (|Et|−1)·|Γ_dut| + noise_Γ + repeatability_Γ
 *
 * Reference: Rytting, "Improved RF hardware and calibration methods for network analyzers"
 */

import { polarToRectangular, rectangularToPolar } from "./commonFunctions.js";
import { realisticOpenGamma, realisticShortGamma, realisticLoadGamma, idealStandards } from "./calibration.js";

// ---------------------------------------------------------------------------
// Residual error computation
// ---------------------------------------------------------------------------

/**
 * Compute residual error terms at a given frequency by comparing the
 * ideal vs. realistic standard models.
 *
 * Returns approximate magnitudes of residual:
 *   Ed (directivity), Es (source match), Et (reflection tracking error: 1 − |actual_tracking|)
 *
 * @param {number} f - frequency in Hz
 * @param {number} zo - reference impedance
 * @param {{openParams, shortParams, loadParams}} realisticParams - realistic model params
 * @returns {{Ed:number, Es:number, Et:number}}
 */
export function computeResidualErrors(f, zo, realisticParams) {
  const openIdeal = idealStandards.open;
  const shortIdeal = idealStandards.short;
  const loadIdeal = idealStandards.load;

  const openReal = realisticOpenGamma(f, zo, realisticParams?.openParams || {});
  const shortReal = realisticShortGamma(f, zo, realisticParams?.shortParams || {});
  const loadReal = realisticLoadGamma(f, zo, realisticParams?.loadParams || {});

  // Δ for each standard (magnitude of error vector)
  const deltaOpen = Math.sqrt(
    (openReal.real - openIdeal.real) ** 2 + (openReal.imaginary - openIdeal.imaginary) ** 2,
  );
  const deltaShort = Math.sqrt(
    (shortReal.real - shortIdeal.real) ** 2 + (shortReal.imaginary - shortIdeal.imaginary) ** 2,
  );
  const deltaLoad = Math.sqrt(
    (loadReal.real - loadIdeal.real) ** 2 + (loadReal.imaginary - loadIdeal.imaginary) ** 2,
  );

  // Residual directivity ≈ error in Load standard (since Load → Γ=0 ideally)
  const Ed = deltaLoad;
  // Residual source match ≈ max of Open/Short errors (they bound the source match circle)
  const Es = Math.max(deltaOpen, deltaShort) * 0.5;
  // Residual tracking ≈ difference between actual and ideal tracking magnitude
  // (simplified: average of Open and Short magnitude deviations from ideal)
  const Et = (deltaOpen + deltaShort) * 0.25;

  return { Ed, Es, Et };
}

// ---------------------------------------------------------------------------
// Per-frequency uncertainty magnitude
// ---------------------------------------------------------------------------

/**
 * Compute worst-case uncertainty magnitude on |S11| at one frequency point.
 *
 * δΓ_total = Ed + |Γ_dut|·Et + |Γ_dut|²·Es + noise_Γ + repeatability_Γ
 *
 * where:
 *   noise_Γ = 10^(noiseFloor_dB/20)      (−80 dBc → 0.0001)
 *   repeatability_Γ = 10^(repeat_dB/20)  (user-set ±dB)
 *
 * @param {number} gammaMag - |S11| (linear) at this frequency
 * @param {number} f - frequency in Hz
 * @param {number} zo - reference impedance
 * @param {{
 *   noiseFloor_dB: number,
 *   repeatability_dB: number,
 *   useIdeal: boolean,
 *   realisticParams: Object
 * }} uncertaintySettings
 * @returns {{deltaGamma:number, Ed:number, Es:number, Et:number, noise_Γ:number, repeat_Γ:number}}
 */
export function uncertaintyAtPoint(gammaMag, f, zo, uncertaintySettings) {
  const { noiseFloor_dB = -80, repeatability_dB = -60, useIdeal = true, realisticParams = {} } = uncertaintySettings || {};

  let Ed = 0;
  let Es = 0;
  let Et = 0;
  if (!useIdeal) {
    ({ Ed, Es, Et } = computeResidualErrors(f, zo, realisticParams));
  }

  const noise_G = Math.pow(10, noiseFloor_dB / 20);
  const repeat_G = Math.pow(10, repeatability_dB / 20);

  const deltaGamma = Ed + gammaMag * Et + gammaMag * gammaMag * Es + noise_G + repeat_G;

  return { deltaGamma, Ed, Es, Et, noise_G, repeat_G };
}

// ---------------------------------------------------------------------------
// Compute uncertainty bands for a full s-param dataset
// ---------------------------------------------------------------------------

/**
 * Compute uncertainty bands (+/− on |S11| in dB) for every frequency point.
 *
 * @param {Object} sparamData - frequency-keyed s-param data (polar S11)
 * @param {number} zo - reference impedance
 * @param {{
 *   enabled: boolean,
 *   noiseFloor_dB: number,
 *   repeatability_dB: number,
 *   useIdeal: boolean,
 *   realisticParams: Object
 * }} uncertaintySettings
 * @returns {{
 *   freqs: number[],
 *   s11_mag_dB: number[],
 *   upper_dB: number[],
 *   lower_dB: number[],
 *   delta_dB: number[],
 *   maxUncertainty_dB: number,
 *   maxUncertainty_f: number,
 *   dominantSource: string
 * }}
 */
export function computeUncertaintyBands(sparamData, zo, uncertaintySettings) {
  if (!uncertaintySettings || !uncertaintySettings.enabled) {
    return { freqs: [], s11_mag_dB: [], upper_dB: [], lower_dB: [], delta_dB: [], maxUncertainty_dB: 0, maxUncertainty_f: 0, dominantSource: "none" };
  }

  const freqs = Object.keys(sparamData)
    .map(Number)
    .sort((a, b) => a - b);
  const s11_mag_dB = [];
  const upper_dB = [];
  const lower_dB = [];
  const delta_dB = [];

  let maxUncertainty_dB = -Infinity;
  let maxUncertainty_f = freqs[0];
  let maxEd = 0;
  let maxEs = 0;
  let maxEt = 0;
  let maxNoise = 0;
  let maxRepeat = 0;

  for (const f of freqs) {
    const point = sparamData[f];
    const gammaMag = point.S11.magnitude;
    const s11dB = 20 * Math.log10(Math.max(gammaMag, 1e-15));

    const { deltaGamma, Ed, Es, Et, noise_G, repeat_G } = uncertaintyAtPoint(gammaMag, f, zo, uncertaintySettings);

    // Convert uncertainty to dB
    const upperMag = Math.min(gammaMag + deltaGamma, 1.0 - 1e-9);
    const lowerMag = Math.max(gammaMag - deltaGamma, 1e-15);

    const upperDB = 20 * Math.log10(upperMag);
    const lowerDB = 20 * Math.log10(lowerMag);
    const deltadB = upperDB - s11dB;

    s11_mag_dB.push(s11dB);
    upper_dB.push(upperDB);
    lower_dB.push(lowerDB);
    delta_dB.push(deltadB);

    if (deltadB > maxUncertainty_dB) {
      maxUncertainty_dB = deltadB;
      maxUncertainty_f = f;
      maxEd = Ed;
      maxEs = Es;
      maxEt = Et;
      maxNoise = noise_G;
      maxRepeat = repeat_G;
    }
  }

  // Dominant error source at worst-case frequency
  const sources = { directivity: maxEd, sourceMatch: maxEs, tracking: maxEt, noise: maxNoise, repeatability: maxRepeat };
  const dominantSource = Object.keys(sources).reduce((a, b) => (sources[a] >= sources[b] ? a : b));

  return {
    freqs,
    s11_mag_dB,
    upper_dB,
    lower_dB,
    delta_dB,
    maxUncertainty_dB,
    maxUncertainty_f,
    dominantSource,
  };
}
