/**
 * deembedding.js
 * 2-port S-parameter de-embedding / embedding via T-matrix (wave-transfer matrix) cascade.
 *
 * T-matrix definition (consistent with microwave convention):
 *   [b1]   [T11 T12] [a2]
 *   [a1] = [T21 T22] [b2]
 *
 * Conversion S → T:
 *   T11 = −det(S)/S21,  T12 = S11/S21
 *   T21 = −S22/S21,     T22 = 1/S21
 *
 * Conversion T → S:
 *   S11 = T12/T22,  S21 = 1/T22
 *   S12 = −T21/T11 (= det(T)/T22),  S22 = −T21/T22
 *   Wait — let's use the standard definition more carefully:
 *
 *   From T → S (using the same convention):
 *   S11 = T12/T22
 *   S12 = det(T)/T22   (det = T11*T22 − T12*T21)
 *   S21 = 1/T22
 *   S22 = −T21/T22
 */

import { complex_multiply, complex_subtract, complex_add, one_over_complex, polarToRectangular, rectangularToPolar, speedOfLight } from "./commonFunctions.js";

// ---------------------------------------------------------------------------
// Complex 2×2 matrix operations
// ---------------------------------------------------------------------------

function matMul(A, B) {
  // A and B are [[a,b],[c,d]] where each element is {real,imaginary}
  return [
    [
      complex_add(complex_multiply(A[0][0], B[0][0]), complex_multiply(A[0][1], B[1][0])),
      complex_add(complex_multiply(A[0][0], B[0][1]), complex_multiply(A[0][1], B[1][1])),
    ],
    [
      complex_add(complex_multiply(A[1][0], B[0][0]), complex_multiply(A[1][1], B[1][0])),
      complex_add(complex_multiply(A[1][0], B[0][1]), complex_multiply(A[1][1], B[1][1])),
    ],
  ];
}

function matDet(M) {
  return complex_subtract(complex_multiply(M[0][0], M[1][1]), complex_multiply(M[0][1], M[1][0]));
}

function matInv(M) {
  const det = matDet(M);
  const invDet = one_over_complex(det);
  return [
    [complex_multiply(M[1][1], invDet), complex_multiply({ real: -M[0][1].real, imaginary: -M[0][1].imaginary }, invDet)],
    [complex_multiply({ real: -M[1][0].real, imaginary: -M[1][0].imaginary }, invDet), complex_multiply(M[0][0], invDet)],
  ];
}

// ---------------------------------------------------------------------------
// S-param ↔ T-matrix conversions
// ---------------------------------------------------------------------------

/**
 * Convert S-parameter object {S11,S12,S21,S22} (polar) to T-matrix.
 * @param {{S11,S12,S21,S22}} sp - polar s-params
 * @returns {Array} 2×2 T-matrix of complex rectangular values
 */
export function sToT(sp) {
  const S11 = polarToRectangular(sp.S11);
  const S12 = polarToRectangular(sp.S12);
  const S21 = polarToRectangular(sp.S21);
  const S22 = polarToRectangular(sp.S22);
  const det = complex_subtract(complex_multiply(S11, S22), complex_multiply(S12, S21));
  const S21inv = one_over_complex(S21);
  return [
    [
      complex_multiply({ real: -det.real, imaginary: -det.imaginary }, S21inv),
      complex_multiply(S11, S21inv),
    ],
    [
      complex_multiply({ real: -S22.real, imaginary: -S22.imaginary }, S21inv),
      { ...S21inv },
    ],
  ];
}

/**
 * Convert T-matrix to S-parameter object (rectangular).
 * @param {Array} T - 2×2 complex rectangular T-matrix
 * @returns {{S11,S12,S21,S22}} rectangular s-params
 */
export function tToS(T) {
  const T22inv = one_over_complex(T[1][1]);
  const detT = matDet(T);
  const S11 = complex_multiply(T[0][1], T22inv);
  const S12 = complex_multiply(detT, T22inv);
  const S21 = { ...T22inv };
  const S22 = complex_multiply({ real: -T[1][0].real, imaginary: -T[1][0].imaginary }, T22inv);
  return { S11, S12, S21, S22 };
}

// ---------------------------------------------------------------------------
// Ideal transmission-line fixture T-matrix
// ---------------------------------------------------------------------------

/**
 * Compute the T-matrix for an ideal transmission-line fixture at one frequency.
 * The two-port T-matrix for a lossless T-line of electrical length θ = βℓ is:
 *   T = [[e^{jθ}, 0], [0, e^{-jθ}]]   (for matched-line fixture)
 *
 * More precisely, the S-params of an ideal T-line (Zo = reference) are:
 *   S11 = S22 = 0,  S21 = S12 = e^{-jθ}
 *
 * @param {number} length - metres
 * @param {number} eeff
 * @param {number} f - Hz
 * @returns {Array} 2×2 T-matrix
 */
export function tLineFixtureTMatrix(length, eeff, f) {
  const beta = (2 * Math.PI * f * Math.sqrt(eeff)) / speedOfLight;
  const theta = beta * length;
  const sp = {
    S11: { magnitude: 0, angle: 0 },
    S22: { magnitude: 0, angle: 0 },
    S21: { magnitude: 1, angle: (-theta * 180) / Math.PI },
    S12: { magnitude: 1, angle: (-theta * 180) / Math.PI },
  };
  return sToT(sp);
}

// ---------------------------------------------------------------------------
// De-embedding / Embedding
// ---------------------------------------------------------------------------

/**
 * De-embed a DUT 2-port from measured S-params by removing a fixture on each port.
 *
 * T_dut = T_fixture1_inv · T_measured · T_fixture2_inv
 *
 * @param {{S11,S12,S21,S22}} measuredSpPolar - measured S-params (polar, each frequency point)
 * @param {{S11,S12,S21,S22}} fixtureSpPolar - fixture S-params (polar, same frequency)
 *        For symmetric fixture use the same object for both ports.
 * @param {{S11,S12,S21,S22}} [fixture2SpPolar] - optional second fixture (port 2 side).
 *        Defaults to fixtureSpPolar if not provided.
 * @returns {{S11,S12,S21,S22}} de-embedded DUT S-params (rectangular)
 */
export function deembedSparams(measuredSpPolar, fixtureSpPolar, fixture2SpPolar) {
  const Tm = sToT(measuredSpPolar);
  const Tf1 = sToT(fixtureSpPolar);
  const Tf2 = sToT(fixture2SpPolar || fixtureSpPolar);

  const Tf1inv = matInv(Tf1);
  const Tf2inv = matInv(Tf2);

  const Tdut = matMul(matMul(Tf1inv, Tm), Tf2inv);
  return tToS(Tdut);
}

/**
 * Embed a DUT 2-port by cascading fixture S-params.
 *
 * T_embedded = T_fixture1 · T_dut · T_fixture2
 *
 * @param {{S11,S12,S21,S22}} dutSpPolar - DUT S-params (polar)
 * @param {{S11,S12,S21,S22}} fixtureSpPolar - fixture S-params (polar)
 * @param {{S11,S12,S21,S22}} [fixture2SpPolar] - optional second fixture
 * @returns {{S11,S12,S21,S22}} embedded S-params (rectangular)
 */
export function embedSparams(dutSpPolar, fixtureSpPolar, fixture2SpPolar) {
  const Td = sToT(dutSpPolar);
  const Tf1 = sToT(fixtureSpPolar);
  const Tf2 = sToT(fixture2SpPolar || fixtureSpPolar);

  const Temb = matMul(matMul(Tf1, Td), Tf2);
  return tToS(Temb);
}

// ---------------------------------------------------------------------------
// Apply to full frequency-keyed dataset
// ---------------------------------------------------------------------------

/**
 * Apply de-embedding to a full frequency-keyed s2p dataset.
 * Fixture is either an ideal T-line or a frequency-keyed s2p data object.
 *
 * @param {Object} sparamData - frequency-keyed s2p data (polar)
 * @param {{
 *   enabled: boolean,
 *   mode: "deembed"|"embed",
 *   fixtureType: "tline"|"sparam",
 *   fixtureLength: number, fixtureZo: number, fixtureEeff: number,
 *   fixtureData?: Object  (frequency-keyed s2p)
 * }} deembedSettings
 * @returns {Object} corrected frequency-keyed s2p data
 */
export function applyDeembedding(sparamData, deembedSettings) {
  if (!deembedSettings || !deembedSettings.enabled) return sparamData;
  const result = {};
  for (const fStr in sparamData) {
    const f = Number(fStr);
    const point = sparamData[fStr];

    let fixtureSp;
    if (deembedSettings.fixtureType === "tline") {
      const T = tLineFixtureTMatrix(deembedSettings.fixtureLength || 0, deembedSettings.fixtureEeff || 1, f);
      const s = tToS(T);
      // Convert rectangular to polar for the deembed function input
      fixtureSp = {
        S11: rectangularToPolar(s.S11),
        S12: rectangularToPolar(s.S12),
        S21: rectangularToPolar(s.S21),
        S22: rectangularToPolar(s.S22),
      };
    } else if (deembedSettings.fixtureType === "sparam" && deembedSettings.fixtureData) {
      // Find nearest frequency in fixture data
      const fixtureFreqs = Object.keys(deembedSettings.fixtureData).map(Number);
      let nearestF = fixtureFreqs[0];
      let minDiff = Math.abs(f - nearestF);
      for (const ff of fixtureFreqs) {
        const diff = Math.abs(f - ff);
        if (diff < minDiff) {
          minDiff = diff;
          nearestF = ff;
        }
      }
      fixtureSp = deembedSettings.fixtureData[nearestF];
    } else {
      result[fStr] = point;
      continue;
    }

    let corrected;
    if (deembedSettings.mode === "embed") {
      corrected = embedSparams(point, fixtureSp);
    } else {
      corrected = deembedSparams(point, fixtureSp);
    }

    result[fStr] = {
      ...point,
      S11: rectangularToPolar(corrected.S11),
      S12: rectangularToPolar(corrected.S12),
      S21: rectangularToPolar(corrected.S21),
      S22: rectangularToPolar(corrected.S22),
    };
  }
  return result;
}
