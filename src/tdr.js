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
 * Gate shapes (Kaiser β per Keysight convention):
 *   "minimum"  : β = 6
 *   "nominal"  : β = 9
 *   "wide"     : β = 13
 *   "maximum"  : β = 16
 */

import { speedOfLight, polarToRectangular, rectangularToPolar } from "./commonFunctions.js";

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
 * Window metadata: sidelobe level (dB) and resolution factor relative to rectangular.
 * Values from standard DSP literature.
 */
export const windowInfo = {
  rectangular: { sidelobe_dB: -13, resolutionFactor: 1.0, label: "Rectangular" },
  hamming: { sidelobe_dB: -42, resolutionFactor: 1.36, label: "Hamming" },
  hanning: { sidelobe_dB: -31, resolutionFactor: 1.44, label: "Hanning" },
  blackman: { sidelobe_dB: -58, resolutionFactor: 1.73, label: "Blackman" },
  kaiser6: { sidelobe_dB: -44, resolutionFactor: 1.40, label: "Kaiser (β=6)" },
  kaiser13: { sidelobe_dB: -70, resolutionFactor: 1.92, label: "Kaiser (β=13)" },
};

/** Gate-shape → Kaiser β mapping (Keysight convention). */
export const gateShapeToKaiserBeta = {
  minimum: 6,
  nominal: 9,
  wide: 13,
  maximum: 16,
};

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
    return { timeAxis: [], realPart: [], imagPart: [], magnitude: [], fStart: 0, fStop: 0, df: 0, N: 0 };
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
    // Low-pass modes: enforce conjugate symmetry so IFFT → real signal.
    // Synthesize DC value by linear extrapolation of first two points.
    const s0r = polarToRectangular(sparamFreqData[freqs[0]].S11);
    const s1r = polarToRectangular(sparamFreqData[freqs[1]].S11);
    const dcRe = s0r.real - (s1r.real - s0r.real);
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
      return { timeAxis, realPart: stepRe, imagPart: stepIm, magnitude: stepMag, fStart, fStop, df, N: Nused, window: Array.from(win) };
    }

    return { timeAxis, realPart, imagPart, magnitude, fStart, fStop, df, N: Nused, window: Array.from(win) };
  }

  // Bandpass path: IFFT
  fftInPlace(reArr, imArr, true);
  const df = freqs.length > 1 ? (fStop - fStart) / (freqs.length - 1) : 1;
  const dt = 1 / (df * Nfft);
  const timeAxis = Array.from({ length: Nfft }, (_, i) => i * dt);
  const realPart = Array.from(reArr);
  const imagPart = Array.from(imArr);
  const magnitude = realPart.map((r, i) => Math.sqrt(r * r + imagPart[i] * imagPart[i]));

  return { timeAxis, realPart, imagPart, magnitude, fStart, fStop, df, N: Nfft, window: Array.from(win) };
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
 * @param {"minimum"|"nominal"|"wide"|"maximum"} gateShape
 * @param {boolean} [gateNotch=false] - when true, notch (reject) the gate window instead of passing it
 * @returns {{
 *   gatedTdReal: number[], gatedTdImag: number[],
 *   gatedFdMag: number[], gatedFdPhase: number[],
 *   freqAxis: number[]
 * }}
 */
export function applyGate(tdData, tStart, tStop, gateShape = "nominal", gateNotch = false) {
  const { timeAxis, realPart, imagPart, fStart, fStop, df, N, window: specWin } = tdData;
  if (!timeAxis || timeAxis.length === 0) {
    return { gatedTdReal: [], gatedTdImag: [], gatedFdMag: [], gatedFdPhase: [], freqAxis: [] };
  }

  const beta = gateShapeToKaiserBeta[gateShape] ?? 9;
  const dt = timeAxis[1] - timeAxis[0];

  // Compute the full (unclamped) gate index range so that the Kaiser window is
  // sized over the ENTIRE [tStart, tStop] span even when tStart < 0 or
  // tStop > tMax.  Clamping only happens when we index into the time-domain
  // arrays; the Kaiser window offset is preserved so that, for example, a gate
  // of [-2 ns, +2 ns] centres its peak on t = 0 rather than at the start.
  const i0_raw = Math.round(tStart / dt);
  const i1_raw = Math.round(tStop / dt);
  const i0 = Math.max(0, i0_raw);
  const i1 = Math.min(N - 1, i1_raw);
  const gateLen_full = i1_raw - i0_raw + 1;             // Kaiser window length (full span)
  const kaiserOffset = i0 - i0_raw;                     // samples skipped from the left
  const gateWin = gateLen_full > 1 ? kaiserWindow(gateLen_full, beta) : [1];

  // Apply gate window
  const gatedRe = new Float64Array(N);
  const gatedIm = new Float64Array(N);

  if (!gateNotch) {
    // Passband: keep only the gate window, zero everything outside
    for (let i = i0; i <= i1; i++) {
      const w = gateWin[i - i0 + kaiserOffset];
      gatedRe[i] = realPart[i] * w;
      gatedIm[i] = imagPart[i] * w;
    }
  } else {
    // Notch: pass everything outside, suppress inside with Kaiser-weighted attenuation
    for (let i = 0; i < N; i++) {
      gatedRe[i] = realPart[i];
      gatedIm[i] = imagPart[i];
    }
    for (let i = i0; i <= i1; i++) {
      const w = gateWin[i - i0 + kaiserOffset]; // Kaiser window: ~0 at edges → ~1 at center; (1-w) inverts for notch suppression
      gatedRe[i] = realPart[i] * (1 - w);
      gatedIm[i] = imagPart[i] * (1 - w);
    }
  }

  // FFT gated time-domain data back to frequency domain
  const fftRe = new Float64Array(N);
  const fftIm = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    fftRe[i] = gatedRe[i];
    fftIm[i] = gatedIm[i];
  }
  fftInPlace(fftRe, fftIm, false); // forward FFT

  // Build frequency axis.
  // Only the first M bins (original measured frequency count) carry meaningful
  // spectral content; bins beyond M were zero-padded and produce artefacts.
  const halfN = Math.floor(N / 2);
  const M = df > 0 ? Math.round((fStop - fStart) / df) + 1 : halfN;
  const nOut = Math.min(halfN, M);
  const freqAxis = [];
  const gatedFdMag = [];
  const gatedFdPhase = [];
  for (let k = 0; k < nOut; k++) {
    const fk = fStart + k * df;
    freqAxis.push(fk);
    // The round-trip IFFT→gate→FFT introduces a per-frequency factor of specWin[k]
    // (the spectral window applied before the IFFT).  Dividing by specWin[k] recovers
    // the true S11[k].  We floor at 1e-6 to avoid divide-by-zero for windows (e.g.
    // Hanning) whose edge bins are zero; those bins were already zeroed in the IFFT
    // and remain near-zero after correction.
    const sw = Math.max(specWin ? (specWin[k] ?? 1) : 1, 1e-6);
    const mag = Math.sqrt(fftRe[k] * fftRe[k] + fftIm[k] * fftIm[k]) / sw;
    const phase = (Math.atan2(fftIm[k], fftRe[k]) * 180) / Math.PI;
    gatedFdMag.push(mag);
    gatedFdPhase.push(phase);
  }

  return {
    gatedTdReal: Array.from(gatedRe),
    gatedTdImag: Array.from(gatedIm),
    gatedFdMag,
    gatedFdPhase,
    freqAxis,
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
  const { freqAxis, gatedFdMag, gatedFdPhase } = gatedResult;
  if (!freqAxis || freqAxis.length === 0) return originalSParamData;

  // Build a lookup from the gated result arrays
  const n = freqAxis.length;

  const result = {};
  const origFreqs = Object.keys(originalSParamData).map(Number).sort((a, b) => a - b);

  for (const fStr of Object.keys(originalSParamData)) {
    const f = Number(fStr);

    // Find nearest index in gated freqAxis
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (freqAxis[mid] < f) lo = mid + 1;
      else hi = mid;
    }
    // lo is the first index where freqAxis[lo] >= f
    let idx = lo;
    if (idx > 0 && Math.abs(freqAxis[idx - 1] - f) < Math.abs(freqAxis[idx] - f)) idx = idx - 1;

    if (idx >= n) idx = n - 1;

    const mag = gatedFdMag[idx] ?? 0;
    const angle = gatedFdPhase[idx] ?? 0;

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
export function computeTdrResolution(sparamFreqData, windowType = "rectangular", velocityFactor = 1) {
  const freqs = Object.keys(sparamFreqData)
    .map(Number)
    .sort((a, b) => a - b);
  if (freqs.length < 2) return { resolution_s: 0, resolution_m: 0, maxTime_s: 0, maxTime_m: 0, fSpan: 0 };

  const fStart = freqs[0];
  const fStop = freqs[freqs.length - 1];
  const fSpan = fStop - fStart;
  const resF = windowInfo[windowType]?.resolutionFactor ?? 1.0;

  const resolution_s = resF / fSpan;
  const resolution_m = (resolution_s * speedOfLight * velocityFactor) / 2; // one-way

  const df = fSpan / (freqs.length - 1);
  const maxTime_s = 1 / df;
  const maxTime_m = (maxTime_s * speedOfLight * velocityFactor) / 2;

  return { resolution_s, resolution_m, maxTime_s, maxTime_m, fSpan };
}
