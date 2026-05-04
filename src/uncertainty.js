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
// Fixture path attenuation (auto-computed from component stackup)
// ---------------------------------------------------------------------------

/**
 * Estimate the one-way fixture path attenuation in dB for each frequency,
 * by cascading the fixture components between the DUT and the calibration plane.
 *
 * For ideal (lossless) transmission lines and lumped elements this returns 0 dB.
 * For a lossy TL with a resistive loss model it returns 2·α·length (two-way).
 *
 * Supported component types:
 *   - "transmissionLine": uses the line's Zo and Eeff to compute the characteristic
 *     impedance mismatch loss.  If the component has a "loss" or "attenuation_dB_m"
 *     field the attenuation is applied as α·length.
 *   - "seriesRes" / "shortedRes": contributes resistive insertion loss.
 *   - All other components: assumed lossless (0 dB contribution).
 *
 * @param {Array}    fixtureComponents - slice of userCircuit on the DUT side of the cal plane
 * @param {number[]} frequencies       - frequencies in Hz
 * @param {number}   zo                - reference impedance (Ω)
 * @returns {number[]} one-way path attenuation in dB, parallel to frequencies array
 */
export function computeFixturePathAttenuation_dB(fixtureComponents, frequencies, zo) {
  if (!fixtureComponents || fixtureComponents.length === 0 || !frequencies || frequencies.length === 0) {
    return frequencies.map(() => 0);
  }

  return frequencies.map((f) => {
    let total_dB = 0;
    for (const comp of fixtureComponents) {
      if (!comp || !comp.name) continue;

      if (comp.name === "transmissionLine" || comp.name === "stub" || comp.name === "shortedStub") {
        // Lossy TL: attenuation = loss_dB_per_m * length
        const lengthM = parseFloat(comp.value) * ({ mm: 1e-3, um: 1e-6, m: 1 }[comp.unit] ?? 1);
        const atten_dB_m = parseFloat(comp.attenuation_dB_m) || 0;
        if (atten_dB_m > 0 && lengthM > 0) {
          total_dB += atten_dB_m * lengthM;
        }
        // Mismatch loss from TL Zo ≠ zo is negligible for educational use; skip.
      } else if (comp.name === "seriesRes" || comp.name === "shortedRes") {
        // Series resistor: insertion loss ≈ R/(R + 2*zo) in power (rough approx for small R)
        const R = parseFloat(comp.value) || 0;
        if (R > 0) {
          const transCoeff = (2 * zo) / (2 * zo + R); // voltage transmission
          total_dB += -20 * Math.log10(Math.max(transCoeff, 1e-15));
        }
      }
      // Other component types: assume lossless
    }
    return total_dB;
  });
}

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
 * δΓ_total = Ed + |Γ_dut|·Et + |Γ_dut|²·Es + noise_Γ_eff + repeatability_Γ
 *
 * where:
 *   noise_Γ = 10^(noiseFloor_dB/20)      (−60 dBc → 0.001)
 *   repeatability_Γ = 10^(repeat_dB/20)  (user-set ±dB)
 *
 *   noise_Γ_eff = noise_Γ / 10^(pathAttenuation_dB/10)
 *     Path attenuation between the calibration plane and the DUT (e.g. a lossy
 *     cable or attenuator) degrades the effective noise floor.  A one-way power
 *     loss of A_dB results in a two-way (round-trip) Γ amplitude loss of A_dB,
 *     so the noise floor Γ grows by the same factor: noise_Γ_eff = noise_Γ / A_lin
 *     where A_lin = 10^(pathAttenuation_dB/10) is the one-way power ratio.
 *
 * @param {number} gammaMag - |S11| (linear) at this frequency
 * @param {number} f - frequency in Hz
 * @param {number} zo - reference impedance
 * @param {{
 *   noiseFloor_dB: number,
 *   repeatability_dB: number,
 *   pathAttenuation_dB: number,
 *   useIdeal: boolean,
 *   realisticParams: Object
 * }} uncertaintySettings
 * @returns {{deltaGamma:number, Ed:number, Es:number, Et:number, noise_G:number, repeat_G:number, pathAtten_G:number}}
 *
 * (noise_G is the effective noise floor Γ after applying path attenuation)
 */
export function uncertaintyAtPoint(gammaMag, f, zo, uncertaintySettings) {
  const { noiseFloor_dB = -60, repeatability_dB = -50, pathAttenuation_dB = 0, useIdeal = true, realisticParams = {} } = uncertaintySettings || {};

  let Ed = 0;
  let Es = 0;
  let Et = 0;
  if (!useIdeal) {
    ({ Ed, Es, Et } = computeResidualErrors(f, zo, realisticParams));
  }

  const noise_G_raw = Math.pow(10, noiseFloor_dB / 20);
  const repeat_G = Math.pow(10, repeatability_dB / 20);

  // Path attenuation degrades the noise floor at the DUT. A one-way power
  // loss of pathAttenuation_dB means the received signal is weaker, so the
  // minimum detectable Γ grows: noise_G_eff = noise_G_raw / 10^(A_dB/10).
  // Guard against zero or near-zero path attenuation to avoid division by zero
  const pathAtten_lin = Math.pow(10, pathAttenuation_dB / 10);
  const noise_G = noise_G_raw / Math.max(pathAtten_lin, 1e-15); // 1e-15: prevent division by zero

  // Expose the degradation contribution separately for dominant-source reporting
  const pathAtten_G = noise_G - noise_G_raw;

  const deltaGamma = Ed + gammaMag * Et + gammaMag * gammaMag * Es + noise_G + repeat_G;

  return { deltaGamma, Ed, Es, Et, noise_G, repeat_G, pathAtten_G };
}

// ---------------------------------------------------------------------------
// Compute uncertainty bands for a full s-param dataset
// ---------------------------------------------------------------------------

/**
 * Compute uncertainty bands (+/− on |S11| in dB) for every frequency point.
 *
 * @param {Object}    sparamData           - frequency-keyed s-param data (polar S11)
 * @param {number}    zo                   - reference impedance
 * @param {{
 *   enabled: boolean,
 *   noiseFloor_dB: number,
 *   repeatability_dB: number,
 *   pathAttenuation_dB: number,
 *   useIdeal: boolean,
 *   realisticParams: Object
 * }} uncertaintySettings
 * @param {number[]|null} [perFreqAttenuation_dB] - optional per-frequency path attenuation
 *   array (parallel to sorted freq keys).  When provided, overrides the scalar
 *   `pathAttenuation_dB` from uncertaintySettings on a per-frequency basis.
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
export function computeUncertaintyBands(sparamData, zo, uncertaintySettings, perFreqAttenuation_dB = null) {
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
  let maxPathAtten = 0;

  for (let fi = 0; fi < freqs.length; fi++) {
    const f = freqs[fi];
    const point = sparamData[f];
    const gammaMag = point.S11.magnitude;
    const s11dB = 20 * Math.log10(Math.max(gammaMag, 1e-15));

    // Per-frequency attenuation overrides the scalar when provided
    const settingsForFreq =
      perFreqAttenuation_dB && perFreqAttenuation_dB.length > fi
        ? { ...uncertaintySettings, pathAttenuation_dB: perFreqAttenuation_dB[fi] }
        : uncertaintySettings;

    const { deltaGamma, Ed, Es, Et, noise_G, repeat_G, pathAtten_G } = uncertaintyAtPoint(gammaMag, f, zo, settingsForFreq);

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
      maxPathAtten = pathAtten_G;
    }
  }

  // Dominant error source at worst-case frequency
  const sources = { directivity: maxEd, sourceMatch: maxEs, tracking: maxEt, noise: maxNoise, repeatability: maxRepeat, pathAttenuation: maxPathAtten };
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
