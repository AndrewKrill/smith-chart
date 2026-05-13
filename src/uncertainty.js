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

import { polarToRectangular, reflToZ } from "./commonFunctions.js";
import { realisticOpenGamma, realisticShortGamma, realisticLoadGamma, idealStandards } from "./calibration.js";
import { synthesizeS11FromCircuit } from "./impedanceFunctions.js";

// ---------------------------------------------------------------------------
// Calibration-path attenuation (auto-computed from component stackup)
// ---------------------------------------------------------------------------

/**
 * Estimate calibration-path attenuation in dB for each frequency using a
 * sensitivity-based reflection model.
 *
 * The method perturbs DUT reflection by a known ΔΓ around the calibration plane,
 * simulates how strongly that perturbation appears at the VNA port through the
 * full component stack, and converts the attenuation of this mapping to dB.
 * This naturally includes the response of all supported components and their
 * parasitics (ESR/ESL, stubs, transformers, etc.).
 *
 * @param {Array}    calibrationPathComponents - slice of userCircuit on the measurement side of the cal plane
 * @param {number[]} frequencies       - frequencies in Hz
 * @param {number}   zo                - reference impedance (Ω)
 * @returns {number[]} path attenuation in dB, parallel to frequencies array
 */
export function computeCalibrationPathAttenuation_dB(calibrationPathComponents, frequencies, zo) {
  if (!frequencies || frequencies.length === 0) return [];
  if (!calibrationPathComponents || calibrationPathComponents.length === 0) {
    return frequencies.map(() => 0);
  }

  // Estimate reflection-path attenuation from DUT-plane Γ sensitivity:
  // A_dB = -20*log10( |ΔΓ_measured| / |ΔΓ_dut| )
  // This captures all component responses/parasitics in the calibration path.
  const gammaHi = 0.2;
  const gammaLo = -0.2;
  const deltaGammaDut = Math.abs(gammaHi - gammaLo);
  const dutHiZ = (zo * (1 + gammaHi)) / (1 - gammaHi);
  const dutLoZ = (zo * (1 + gammaLo)) / (1 - gammaLo);

  const path = calibrationPathComponents.filter((c) => !!c);
  const hiCircuit = [{ name: "blackBox", real: dutHiZ, imaginary: 0 }, ...path];
  const loCircuit = [{ name: "blackBox", real: dutLoZ, imaginary: 0 }, ...path];

  const hiData = synthesizeS11FromCircuit(hiCircuit, frequencies, zo);
  const loData = synthesizeS11FromCircuit(loCircuit, frequencies, zo);

  if (!hiData || !loData) return frequencies.map(() => 0);

  return frequencies.map((f) => {
    const pHi = hiData[String(f)]?.S11;
    const pLo = loData[String(f)]?.S11;
    if (!pHi || !pLo) return 0;
    const gHi = polarToRectangular(pHi);
    const gLo = polarToRectangular(pLo);
    const deltaGammaMeasured = Math.hypot(gHi.real - gLo.real, gHi.imaginary - gLo.imaginary);
    const sensitivity = deltaGammaMeasured / Math.max(deltaGammaDut, 1e-15);
    const attenuation_dB = -20 * Math.log10(Math.max(sensitivity, 1e-15));
    return Math.max(0, attenuation_dB);
  });
}

// Backward-compatible alias
export const computeFixturePathAttenuation_dB = computeCalibrationPathAttenuation_dB;

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
  const deltaOpen = Math.sqrt((openReal.real - openIdeal.real) ** 2 + (openReal.imaginary - openIdeal.imaginary) ** 2);
  const deltaShort = Math.sqrt((shortReal.real - shortIdeal.real) ** 2 + (shortReal.imaginary - shortIdeal.imaginary) ** 2);
  const deltaLoad = Math.sqrt((loadReal.real - loadIdeal.real) ** 2 + (loadReal.imaginary - loadIdeal.imaginary) ** 2);

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
 *   noise_Γ_eff = noise_Γ * 10^(pathAttenuation_dB/20)
 *     Path attenuation between the calibration plane and the DUT reduces the
 *     reflected signal seen by the VNA, so the minimum detectable DUT Γ grows
 *     by the same amplitude ratio.
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

  // Positive pathAttenuation_dB means weaker reflected signal at the receiver,
  // therefore larger minimum detectable DUT Γ by the same amplitude factor.
  const pathAtten_lin = Math.pow(10, pathAttenuation_dB / 20);
  const noise_G = noise_G_raw * pathAtten_lin;

  // Expose the degradation contribution separately for dominant-source reporting
  const pathAtten_G = Math.max(0, noise_G - noise_G_raw);

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
 *   s11_phase_deg: number[],
 *   phase_upper_deg: number[],
 *   phase_lower_deg: number[],
 *   z_mag_ohm: number[],
 *   z_upper_ohm: number[],
 *   z_lower_ohm: number[],
 *   delta_dB: number[],
 *   maxUncertainty_dB: number,
 *   maxUncertainty_f: number,
 *   dominantSource: string
 * }}
 */
export function computeUncertaintyBands(sparamData, zo, uncertaintySettings, perFreqAttenuation_dB = null) {
  if (!uncertaintySettings || !uncertaintySettings.enabled) {
    return {
      freqs: [],
      s11_mag_dB: [],
      upper_dB: [],
      lower_dB: [],
      s11_phase_deg: [],
      phase_upper_deg: [],
      phase_lower_deg: [],
      z_mag_ohm: [],
      z_upper_ohm: [],
      z_lower_ohm: [],
      delta_dB: [],
      maxUncertainty_dB: 0,
      maxUncertainty_f: 0,
      dominantSource: "none",
    };
  }

  const freqs = Object.keys(sparamData)
    .map(Number)
    .sort((a, b) => a - b);
  const s11_mag_dB = [];
  const upper_dB = [];
  const lower_dB = [];
  const s11_phase_deg = [];
  const phase_upper_deg = [];
  const phase_lower_deg = [];
  const z_mag_ohm = [];
  const z_upper_ohm = [];
  const z_lower_ohm = [];
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
    const gammaAngle = Number(point.S11.angle) || 0;
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
    const phaseSpanDeg =
      gammaMag <= 1e-15 || deltaGamma >= gammaMag ? 180 : (Math.asin(Math.min(1, deltaGamma / Math.max(gammaMag, 1e-15))) * 180) / Math.PI;
    const phaseLower = Math.max(-180, gammaAngle - phaseSpanDeg);
    const phaseUpper = Math.min(180, gammaAngle + phaseSpanDeg);

    const zMagAtNominal = Math.hypot(...Object.values(reflToZ(polarToRectangular({ magnitude: gammaMag, angle: gammaAngle }), zo)));
    const zMagAtUpper = Math.hypot(...Object.values(reflToZ(polarToRectangular({ magnitude: upperMag, angle: gammaAngle }), zo)));
    const zMagAtLower = Math.hypot(...Object.values(reflToZ(polarToRectangular({ magnitude: lowerMag, angle: gammaAngle }), zo)));
    const zLower = Math.min(zMagAtUpper, zMagAtLower);
    const zUpper = Math.max(zMagAtUpper, zMagAtLower);

    s11_mag_dB.push(s11dB);
    upper_dB.push(upperDB);
    lower_dB.push(lowerDB);
    s11_phase_deg.push(gammaAngle);
    phase_upper_deg.push(phaseUpper);
    phase_lower_deg.push(phaseLower);
    z_mag_ohm.push(zMagAtNominal);
    z_upper_ohm.push(zUpper);
    z_lower_ohm.push(zLower);
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
  const sources = {
    directivity: maxEd,
    sourceMatch: maxEs,
    tracking: maxEt,
    noise: maxNoise,
    repeatability: maxRepeat,
    pathAttenuation: maxPathAtten,
  };
  const dominantSource = Object.keys(sources).reduce((a, b) => (sources[a] >= sources[b] ? a : b));

  return {
    freqs,
    s11_mag_dB,
    upper_dB,
    lower_dB,
    s11_phase_deg,
    phase_upper_deg,
    phase_lower_deg,
    z_mag_ohm,
    z_upper_ohm,
    z_lower_ohm,
    delta_dB,
    maxUncertainty_dB,
    maxUncertainty_f,
    dominantSource,
  };
}
