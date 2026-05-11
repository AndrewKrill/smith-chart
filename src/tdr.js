/**
 * tdr.js
 * Time-Domain Reflectometry (TDR) / Gating / Transform functionality.
 *
 * Provides:
 *   - frequencyToTimeDomain(sparamFreqData, mode, windowType)
 *   - applyGate(timeDomainData, tStart, tStop, gateShape)
 *   - windowInfo(windowType) — sidelobe / resolution metadata
 *
 * Modes:
 *   "bandpass"        : straight IFFT of complex band-limited data
 *   "lowpass_impulse" : enforce conjugate symmetry → real impulse response
 *   "lowpass_step"    : cumulative sum of low-pass impulse → step response
 *
 * Gate shapes (VNA-style cutoff/min-span rules):
 *   "minimum" | "normal" | "wide" | "maximum"
 * (legacy "nominal" is mapped to "normal")
 */

import { speedOfLight, polarToRectangular, rectangularToPolar } from "./commonFunctions.js";

const MIN_SPECTRAL_WINDOW_WEIGHT = 1e-9;

// ---------------------------------------------------------------------------
// Window functions
// ---------------------------------------------------------------------------

/** Modified Bessel I0 (series approximation, sufficient for Kaiser window). */
function besselI0(x) {
  let sum = 1;
  let term = 1;
  const halfX = x / 2;
  for (let k = 1; k <= 25; k++) {
    term *= (halfX / k) * (halfX / k);
    sum += term;
    if (term < 1e-15 * sum) break;
  }
  return sum;
}

function kaiserWindow(N, beta) {
  const w = new Array(N);
  const I0beta = besselI0(beta);
  for (let n = 0; n < N; n++) {
    const x = (2 * n) / (N - 1) - 1; // −1 to +1
    w[n] = besselI0(beta * Math.sqrt(1 - x * x)) / I0beta;
  }
  return w;
}

function hammingWindow(N) {
  const w = new Array(N);
  for (let n = 0; n < N; n++) {
    w[n] = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (N - 1));
  }
  return w;
}

function hanningWindow(N) {
  const w = new Array(N);
  for (let n = 0; n < N; n++) {
    w[n] = 0.5 * (1 - Math.cos((2 * Math.PI * n) / (N - 1)));
  }
  return w;
}

function blackmanWindow(N) {
  const w = new Array(N);
  for (let n = 0; n < N; n++) {
    w[n] = 0.42 - 0.5 * Math.cos((2 * Math.PI * n) / (N - 1)) + 0.08 * Math.cos((4 * Math.PI * n) / (N - 1));
  }
  return w;
}

function rectangularWindow(N) {
  return new Array(N).fill(1);
}

/**
 * Build window array for N points.
 * @param {number} N
 * @param {string} type - "rectangular","hamming","hanning","blackman","kaiser6","kaiser13"
 * @returns {number[]}
 */
export function buildWindow(N, type) {
  switch ((type || "").toLowerCase()) {
    case "hamming":
      return hammingWindow(N);
    case "hanning":
      return hanningWindow(N);
    case "blackman":
      return blackmanWindow(N);
    case "kaiser6":
      return kaiserWindow(N, 6);
    case "kaiser13":
      return kaiserWindow(N, 13);
    default: // "rectangular"
      return rectangularWindow(N);
  }
}

/**
 * Window metadata: sidelobe level (dB) and approximate VNA-style resolution factor.
 */
export const windowInfo = {
  rectangular: { sidelobe_dB: -13, resolutionFactor: 1.0, label: "Rectangular" },
  hamming: { sidelobe_dB: -42, resolutionFactor: 1.3, label: "Hamming" },
  hanning: { sidelobe_dB: -31, resolutionFactor: 1.4, label: "Hanning" },
  blackman: { sidelobe_dB: -58, resolutionFactor: 1.7, label: "Blackman" },
  kaiser6: { sidelobe_dB: -44, resolutionFactor: 1.35, label: "Kaiser (β=6)" },
  kaiser13: { sidelobe_dB: -70, resolutionFactor: 2.0, label: "Kaiser (β=13)" },
};

/** VNA-style gate shape rules (time values are divided by fSpan). */
export const gateShapeRules = {
  minimum: { cutoffFactor: 1.4, minSpanFactor: 2.8 },
  normal: { cutoffFactor: 2.8, minSpanFactor: 5.6 },
  wide: { cutoffFactor: 4.4, minSpanFactor: 8.8 },
  maximum: { cutoffFactor: 12.7, minSpanFactor: 25.4 },
};

export function normalizeGateShape(gateShape = "normal") {
  const s = (gateShape || "").toLowerCase();
  if (s === "nominal") return "normal";
  if (s in gateShapeRules) return s;
  return "normal";
}

function validateLowPassGrid(freqs) {
  if (!freqs || freqs.length < 2) return { valid: false, reason: "insufficient frequency points" };
  const M = freqs.length;
  const fStart = freqs[0];
  const fStop = freqs[M - 1];
  const df = (fStop - fStart) / (M - 1);
  if (!(df > 0)) return { valid: false, reason: "non-positive frequency spacing" };

  const spacingTol = Math.max(df * 1e-2, 1);
  for (let i = 1; i < M; i++) {
    const step = freqs[i] - freqs[i - 1];
    if (Math.abs(step - df) > spacingTol) {
      return { valid: false, reason: "frequency grid is not uniformly spaced" };
    }
  }

  const expectedStart = fStop / M;
  const harmonicTol = Math.max(expectedStart * 0.05, df * 0.5);
  if (Math.abs(fStart - expectedStart) > harmonicTol) {
    return {
      valid: false,
      reason: "low-pass mode requires a harmonic grid (fStart ≈ fStop / points)",
    };
  }

  return { valid: true, reason: "" };
}

// ---------------------------------------------------------------------------
// Simple Cooley-Tukey FFT / IFFT (no external dependency)
// ---------------------------------------------------------------------------

/**
 * In-place Cooley-Tukey FFT.
 * @param {Float64Array} re - real parts (length must be power of 2)
 * @param {Float64Array} im - imaginary parts
 * @param {boolean} inverse - if true, compute IFFT
 */
function fftInPlace(re, im, inverse = false) {
  const N = re.length;
  // Bit-reversal permutation
  let j = 0;
  for (let i = 1; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  // FFT butterfly
  for (let len = 2; len <= N; len <<= 1) {
    const ang = (2 * Math.PI) / len * (inverse ? 1 : -1);
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k];
        const uIm = im[i + k];
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe;
        im[i + k + len / 2] = uIm - vIm;
        const newCurRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = newCurRe;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < N; i++) {
      re[i] /= N;
      im[i] /= N;
    }
  }
}

/** Next power of 2 >= n. */
function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

// ---------------------------------------------------------------------------
// Frequency → Time Domain Transform
// ---------------------------------------------------------------------------

/**
 * Convert frequency-domain S11 data to time domain.
 *
 * @param {Object} sparamFreqData - frequency-keyed s-param data (polar S11)
 * @param {"bandpass"|"lowpass_impulse"|"lowpass_step"} mode
 * @param {string} windowType - one of the keys in windowInfo
 * @returns {{
 *   timeAxis: number[],   // time in seconds
 *   realPart: number[],   // real part of time-domain response
 *   imagPart: number[],   // imaginary part
 *   magnitude: number[],  // |response|
 *   fStart: number, fStop: number, df: number,
 *   N: number
 * }}
 */
export function frequencyToTimeDomain(sparamFreqData, mode = "bandpass", windowType = "rectangular") {
  const freqs = Object.keys(sparamFreqData)
    .map(Number)
    .sort((a, b) => a - b);
  if (freqs.length < 2) {
    return {
      timeAxis: [],
      realPart: [],
      imagPart: [],
      magnitude: [],
      fStart: 0,
      fStop: 0,
      df: 0,
      N: 0,
      M: 0,
      originalFreqs: [],
      valid: false,
      warning: "Need at least two frequency points",
    };
  }

  const fStart = freqs[0];
  const fStop = freqs[freqs.length - 1];
  const M = freqs.length; // number of measured frequency points

  // Build window
  const win = buildWindow(M, windowType);

  // Zero-pad to next power of 2 for efficient FFT
  const Nfft = nextPow2(Math.max(M * 4, 64)); // 4× zero-padding for interpolation

  let reArr, imArr;

  if (mode === "bandpass") {
    // Straight IFFT of the complex band-limited data.
    // Place measured data in the first M bins; rest are zero.
    reArr = new Float64Array(Nfft);
    imArr = new Float64Array(Nfft);
    for (let k = 0; k < M; k++) {
      const s11r = polarToRectangular(sparamFreqData[freqs[k]].S11);
      reArr[k] = s11r.real * win[k];
      imArr[k] = s11r.imaginary * win[k];
    }
  } else {
    const lowPassGrid = validateLowPassGrid(freqs);
    if (!lowPassGrid.valid) {
      return {
        timeAxis: [],
        realPart: [],
        imagPart: [],
        magnitude: [],
        fStart,
        fStop,
        df: 0,
        N: 0,
        M,
        originalFreqs: [...freqs],
        valid: false,
        warning: `Low-pass transform rejected: ${lowPassGrid.reason}`,
      };
    }

    // Low-pass modes: enforce conjugate symmetry so IFFT → real signal.
    // Use the first harmonic sample real component as the DC estimate.
    const s0r = polarToRectangular(sparamFreqData[freqs[0]].S11);
    const dcRe = s0r.real;
    const dcIm = 0; // DC must be real for a real signal

    // Build one-sided spectrum at indices 0..M
    const oneSidedRe = [dcRe];
    const oneSidedIm = [dcIm];
    for (let k = 0; k < M; k++) {
      const s11r = polarToRectangular(sparamFreqData[freqs[k]].S11);
      oneSidedRe.push(s11r.real * win[k]);
      oneSidedIm.push(s11r.imaginary * win[k]);
    }
    const L = oneSidedRe.length; // M+1

    // Total length = 2*(M+1) → conjugate symmetric
    const totalLen = nextPow2(2 * L * 4);
    reArr = new Float64Array(totalLen);
    imArr = new Float64Array(totalLen);
    for (let k = 0; k < L; k++) {
      reArr[k] = oneSidedRe[k];
      imArr[k] = oneSidedIm[k];
    }
    // Conjugate mirror: index totalLen-k for k=1..L-1
    for (let k = 1; k < L; k++) {
      reArr[totalLen - k] = oneSidedRe[k];
      imArr[totalLen - k] = -oneSidedIm[k];
    }

    fftInPlace(reArr, imArr, true); // IFFT in-place
    const Nused = reArr.length;
    const df = fStop / M; // approximate frequency step
    const dt = 1 / (df * Nused);
    const timeAxis = Array.from({ length: Nused }, (_, i) => i * dt);
    const realPart = Array.from(reArr);
    const imagPart = Array.from(imArr);
    const magnitude = realPart.map((r, i) => Math.sqrt(r * r + imagPart[i] * imagPart[i]));

    if (mode === "lowpass_step") {
      // Integrate (cumulative sum) the impulse to get step response
      let acc = 0;
      const stepRe = realPart.map((v) => {
        acc += v;
        return acc;
      });
      let accI = 0;
      const stepIm = imagPart.map((v) => {
        accI += v;
        return accI;
      });
      const stepMag = stepRe.map((r, i) => Math.sqrt(r * r + stepIm[i] * stepIm[i]));
      return {
        timeAxis,
        realPart: stepRe,
        imagPart: stepIm,
        magnitude: stepMag,
        fStart,
        fStop,
        df,
        N: Nused,
        M,
        originalFreqs: [...freqs],
        window: Array.from(win),
        valid: true,
      };
    }

    return {
      timeAxis,
      realPart,
      imagPart,
      magnitude,
      fStart,
      fStop,
      df,
      N: Nused,
      M,
      originalFreqs: [...freqs],
      window: Array.from(win),
      valid: true,
    };
  }

  // Bandpass path: IFFT
  fftInPlace(reArr, imArr, true);
  const df = freqs.length > 1 ? (fStop - fStart) / (freqs.length - 1) : 1;
  const dt = 1 / (df * Nfft);
  const timeAxis = Array.from({ length: Nfft }, (_, i) => i * dt);
  const realPart = Array.from(reArr);
  const imagPart = Array.from(imArr);
  const magnitude = realPart.map((r, i) => Math.sqrt(r * r + imagPart[i] * imagPart[i]));

  return {
    timeAxis,
    realPart,
    imagPart,
    magnitude,
    fStart,
    fStop,
    df,
    N: Nfft,
    M,
    originalFreqs: [...freqs],
    window: Array.from(win),
    valid: true,
  };
}

// ---------------------------------------------------------------------------
// Gating
// ---------------------------------------------------------------------------

/**
 * Apply a time-domain gate between tStart and tStop with a Kaiser-based shape.
 * The gated time-domain data is FFT'd back to produce gated frequency-domain S11.
 *
 * @param {{timeAxis:number[], realPart:number[], imagPart:number[], fStart:number, fStop:number, df:number, N:number}} tdData
 * @param {number} tStart - gate start in seconds
 * @param {number} tStop - gate stop in seconds
 * @param {"minimum"|"normal"|"nominal"|"wide"|"maximum"} gateShape
 * @param {"bandpass"|"notch"|boolean} [gateType="bandpass"] - boolean kept for backward compatibility
 * @returns {{
 *   gatedTdReal: number[], gatedTdImag: number[],
 *   gatedS11: { frequency:number, S11:{real:number, imaginary:number, magnitude:number, angle:number} }[],
 *   gatedFdMag: number[], gatedFdPhase: number[], freqAxis: number[],
 *   gateShape: string, gateType: "bandpass"|"notch",
 *   valid: boolean, warning?: string
 * }}
 */
export function applyGate(tdData, tStart, tStop, gateShape = "normal", gateType = "bandpass") {
  const { timeAxis, realPart, imagPart, fStart, fStop, df, N, window: specWin } = tdData;
  const normalizedShape = normalizeGateShape(gateShape);
  const modeType = typeof gateType === "boolean" ? (gateType ? "notch" : "bandpass") : gateType || "bandpass";

  const emptyResult = {
    gatedTdReal: [],
    gatedTdImag: [],
    gatedS11: [],
    gatedFdMag: [],
    gatedFdPhase: [],
    freqAxis: [],
    gateShape: normalizedShape,
    gateType: modeType,
    valid: false,
  };

  if (!timeAxis || timeAxis.length === 0) {
    return emptyResult;
  }

  const fSpan = Math.max(fStop - fStart, 0);
  const shapeRule = gateShapeRules[normalizedShape] ?? gateShapeRules.normal;
  const cutoff = fSpan > 0 ? shapeRule.cutoffFactor / fSpan : 0;
  const minSpan = fSpan > 0 ? shapeRule.minSpanFactor / fSpan : 0;
  const gateSpan = tStop - tStart;
  if (!(gateSpan > 0)) {
    return { ...emptyResult, warning: "Invalid gate span: gateStop must be greater than gateStart" };
  }
  if (fSpan > 0 && gateSpan < minSpan) {
    return {
      ...emptyResult,
      warning: `Invalid gate span (${(gateSpan * 1e9).toFixed(3)} ns). Minimum for ${normalizedShape} is ${(minSpan * 1e9).toFixed(3)} ns`,
    };
  }

  const dt = timeAxis[1] - timeAxis[0];
  if (!(dt > 0)) {
    return { ...emptyResult, warning: "Invalid time axis spacing" };
  }
  const fullSpan = dt * (N - 1);
  const isFullSpanGate = gateSpan >= fullSpan - dt * 0.5;

  const i0_raw = Math.round(tStart / dt);
  const gateLen_full = Math.min(Math.max(Math.round(gateSpan / dt) + 1, 1), N);

  function edgeWeight(localT) {
    const edge = Math.max(0, Math.min(cutoff, gateSpan / 2));
    if (edge <= 0 || gateSpan <= 0) return 1;
    if (localT <= edge) return 0.5 * (1 - Math.cos((Math.PI * localT) / edge));
    if (localT >= gateSpan - edge) return 0.5 * (1 - Math.cos((Math.PI * (gateSpan - localT)) / edge));
    return 1;
  }

  const gateMask = new Float64Array(N).fill(modeType === "notch" ? 1 : 0);
  if (isFullSpanGate) {
    gateMask.fill(modeType === "notch" ? 0 : 1);
  } else {
    for (let wi = 0; wi < gateLen_full; wi++) {
      const i = ((i0_raw + wi) % N + N) % N;
      const localT = wi * dt;
      const w = edgeWeight(localT);
      if (modeType === "notch") gateMask[i] = Math.min(gateMask[i], 1 - w);
      else gateMask[i] = Math.max(gateMask[i], w);
    }
  }

  const gatedRe = new Float64Array(N);
  const gatedIm = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    gatedRe[i] = realPart[i] * gateMask[i];
    gatedIm[i] = imagPart[i] * gateMask[i];
  }

  // FFT gated time-domain data back to frequency domain
  const fftRe = new Float64Array(N);
  const fftIm = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    fftRe[i] = gatedRe[i];
    fftIm[i] = gatedIm[i];
  }
  fftInPlace(fftRe, fftIm, false); // forward FFT

  const originalFreqs = tdData.originalFreqs || [];
  const measuredCount = tdData.M || originalFreqs.length || (df > 0 ? Math.round((fStop - fStart) / df) + 1 : 0);
  const freqAxis = [];
  const gatedFdMag = [];
  const gatedFdPhase = [];
  const gatedS11 = [];
  for (let k = 0; k < measuredCount; k++) {
    const defaultFrequency = fStart + k * df;
    const fk = originalFreqs[k] ?? defaultFrequency;
    const sw = Math.max(specWin ? (specWin[k] ?? 1) : 1, MIN_SPECTRAL_WINDOW_WEIGHT);
    const re = fftRe[k] / sw;
    const im = fftIm[k] / sw;
    const polar = rectangularToPolar({ real: re, imaginary: im });
    freqAxis.push(fk);
    gatedFdMag.push(polar.magnitude);
    gatedFdPhase.push(polar.angle);
    gatedS11.push({
      frequency: fk,
      S11: {
        real: re,
        imaginary: im,
        magnitude: polar.magnitude,
        angle: polar.angle,
      },
    });
  }

  return {
    gatedTdReal: Array.from(gatedRe),
    gatedTdImag: Array.from(gatedIm),
    gatedS11,
    gatedFdMag,
    gatedFdPhase,
    freqAxis,
    gateShape: normalizedShape,
    gateType: modeType,
    gateSpan,
    cutoff,
    minSpan,
    valid: true,
  };
}

// ---------------------------------------------------------------------------
// Gate parameter helpers (linked fields like a real VNA)
// ---------------------------------------------------------------------------

/**
 * Given start and stop, compute center and span.
 */
export function gateStartStopToCS(tStart, tStop) {
  const span = tStop - tStart;
  const center = tStart + span / 2;
  return { center, span };
}

/**
 * Given center and span, compute start and stop.
 */
export function gateCsToStartStop(center, span) {
  return { tStart: center - span / 2, tStop: center + span / 2 };
}

// ---------------------------------------------------------------------------
// Convert gated result back to standard S-param keyed format
// ---------------------------------------------------------------------------

/**
 * Map the array-based output of applyGate back to the standard frequency-keyed
 * S-param format { "Hz": { S11: { magnitude, angle } } } so that it can be
 * fed back into the VNA correction pipeline.
 *
 * The gated FFT output (freqAxis) may not align exactly with the original
 * frequency keys.  This function nearest-neighbour interpolates to the
 * original keys (all keys are normally already aligned, but guards against
 * floating-point drift).
 *
 * @param {{ freqAxis:number[], gatedFdMag:number[], gatedFdPhase:number[] }} gatedResult
 * @param {Object} originalSParamData - original frequency-keyed s-param object used as key template
 * @returns {Object} frequency-keyed S-param data in standard format
 */
export function gatedToSParamFormat(gatedResult, originalSParamData) {
  if (!gatedResult || gatedResult.valid === false) return originalSParamData;
  const { gatedS11 = [], freqAxis = [], gatedFdMag = [], gatedFdPhase = [] } = gatedResult;
  if ((!gatedS11 || gatedS11.length === 0) && (!freqAxis || freqAxis.length === 0)) return originalSParamData;

  const result = {};
  const byFreq = new Map(gatedS11.map((p) => [p.frequency, p.S11]));

  for (const fStr of Object.keys(originalSParamData)) {
    const f = Number(fStr);
    let s11 = byFreq.get(f);
    if (!s11 && freqAxis.length > 0) {
      let bestIdx = 0;
      let bestErr = Number.POSITIVE_INFINITY;
      for (let i = 0; i < freqAxis.length; i++) {
        const err = Math.abs(freqAxis[i] - f);
        if (err < bestErr) {
          bestErr = err;
          bestIdx = i;
        }
      }
      if (gatedS11[bestIdx]?.S11) {
        s11 = gatedS11[bestIdx].S11;
      } else {
        s11 = { magnitude: gatedFdMag[bestIdx] ?? 0, angle: gatedFdPhase[bestIdx] ?? 0 };
      }
    }
    const mag = s11?.magnitude ?? 0;
    const angle = s11?.angle ?? 0;

    // Preserve all original fields (S21, etc.) and override S11
    result[fStr] = { ...originalSParamData[fStr], S11: { magnitude: mag, angle } };
  }

  return result;
}

// ---------------------------------------------------------------------------
// Compute resolution & time span
// ---------------------------------------------------------------------------

/**
 * Compute expected TDR time resolution and maximum time span from s-param data.
 *
 * @param {Object} sparamFreqData - frequency-keyed s-param data
 * @param {string} windowType
 * @param {number} [velocityFactor=1] - v/c for converting to distance
 * @returns {{
 *   resolution_s: number, resolution_m: number,
 *   maxTime_s: number, maxTime_m: number,
 *   fSpan: number
 * }}
 */
export function computeTdrResolution(sparamFreqData, mode = "bandpass", windowType = "rectangular", velocityFactor = 1) {
  const freqs = Object.keys(sparamFreqData)
    .map(Number)
    .sort((a, b) => a - b);
  if (freqs.length < 2) return { resolution_s: 0, resolution_m: 0, maxTime_s: 0, maxTime_m: 0, fSpan: 0 };

  const fStart = freqs[0];
  const fStop = freqs[freqs.length - 1];
  const fSpan = fStop - fStart;
  const resF = windowInfo[windowType]?.resolutionFactor ?? 1.0;
  const df = fSpan / (freqs.length - 1);

  let baseResolution = 1 / Math.max(fSpan, 1e-30);
  let maxTime_s = 1 / Math.max(df, 1e-30);
  if (mode === "lowpass_impulse") {
    baseResolution = 1 / Math.max(2 * fStop, 1e-30);
    maxTime_s = 1 / Math.max(2 * df, 1e-30);
  } else if (mode === "lowpass_step") {
    baseResolution = 1 / Math.max(fStop, 1e-30);
    maxTime_s = 1 / Math.max(2 * df, 1e-30);
  }

  const resolution_s = baseResolution * resF;
  const resolution_m = (resolution_s * speedOfLight * velocityFactor) / 2;
  const maxTime_m = (maxTime_s * speedOfLight * velocityFactor) / 2;

  return { resolution_s, resolution_m, maxTime_s, maxTime_m, fSpan, mode };
}
