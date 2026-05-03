/**
 * calibration.js
 * 1-port SOLT (Short-Open-Load-Thru) VNA error-model implementation.
 *
 * Three-term error model (forward path):
 *   e00 = directivity
 *   e11 = source match
 *   e10e01 = reflection tracking
 *
 * Correction formula:
 *   Γ_corrected = (Γ_measured − e00) / (e11·(Γ_measured − e00) + e10e01)
 */

import { complex_add, complex_subtract, complex_multiply, one_over_complex, speedOfLight, polarToRectangular, rectangularToPolar } from "./commonFunctions.js";

// ---------------------------------------------------------------------------
// Standard reflection coefficient models
// ---------------------------------------------------------------------------

/**
 * Ideal standard reflection coefficients (frequency-independent).
 */
export const idealStandards = {
  open: { real: 1, imaginary: 0 }, // Γ = +1
  short: { real: -1, imaginary: 0 }, // Γ = −1
  load: { real: 0, imaginary: 0 }, // Γ = 0
};

/**
 * Compute realistic Open reflection coefficient at a given frequency.
 * Model: residual shunt capacitance C0 + C1*f + C2*f² + C3*f³ (pF terms).
 * Γ_open = (jωC_open * zo − 1) / (jωC_open * zo + 1)   ... but typically
 * for connector Open the standard is Γ=+1 modified by the fringe capacitance:
 *   Zopen = 1 / (jω·Ceff)  →  Γ = (Zopen−zo)/(Zopen+zo)
 *
 * @param {number} f - frequency in Hz
 * @param {number} zo - reference impedance
 * @param {{c0:number,c1:number,c2:number,c3:number}} params - capacitance polynomial (F)
 * @returns {{real:number,imaginary:number}} rectangular reflection coefficient
 */
export function realisticOpenGamma(f, zo, params) {
  const { c0 = 0, c1 = 0, c2 = 0, c3 = 0 } = params;
  const w = 2 * Math.PI * f;
  const Ceff = c0 + c1 * f + c2 * f * f + c3 * f * f * f; // Farads
  if (Math.abs(Ceff) < 1e-30) return { real: 1, imaginary: 0 };
  const jwtimesC = w * Ceff; // ω·C
  // Zopen = 1/(jωC) → admittance Y = jωC
  // Γ = (1 − j·zo·ωC) / (1 + j·zo·ωC)
  const num = { real: 1, imaginary: -zo * jwtimesC };
  const den = { real: 1, imaginary: zo * jwtimesC };
  return complex_multiply(num, one_over_complex(den));
}

/**
 * Compute realistic Short reflection coefficient at a given frequency.
 * Model: residual series inductance L0 + L1*f + L2*f² + L3*f³ (H).
 * Zshort = jω·Leff → Γ = (jωL − zo) / (jωL + zo)
 *
 * @param {number} f - frequency in Hz
 * @param {number} zo - reference impedance
 * @param {{l0:number,l1:number,l2:number,l3:number}} params - inductance polynomial (H)
 * @returns {{real:number,imaginary:number}} rectangular reflection coefficient
 */
export function realisticShortGamma(f, zo, params) {
  const { l0 = 0, l1 = 0, l2 = 0, l3 = 0 } = params;
  const w = 2 * Math.PI * f;
  const Leff = l0 + l1 * f + l2 * f * f + l3 * f * f * f;
  const jwL = w * Leff; // ω·L
  // Γ = (jωL − zo) / (jωL + zo)
  const num = { real: -zo, imaginary: jwL };
  const den = { real: zo, imaginary: jwL };
  return complex_multiply(num, one_over_complex(den));
}

/**
 * Compute realistic Load reflection coefficient at a given frequency.
 * Model: residual resistance offset r_offset and series inductance l_offset (H).
 * Zload = r_offset + jω·l_offset → Γ = (Zload − zo) / (Zload + zo)
 *
 * @param {number} f - frequency in Hz
 * @param {number} zo - reference impedance
 * @param {{r_offset:number,l_offset:number}} params
 * @returns {{real:number,imaginary:number}} rectangular reflection coefficient
 */
export function realisticLoadGamma(f, zo, params) {
  const { r_offset = 0, l_offset = 0 } = params;
  const w = 2 * Math.PI * f;
  const z = { real: zo + r_offset, imaginary: w * l_offset };
  const num = complex_subtract(z, { real: zo, imaginary: 0 });
  const den = complex_add(z, { real: zo, imaginary: 0 });
  return complex_multiply(num, one_over_complex(den));
}

// ---------------------------------------------------------------------------
// Error-term computation
// ---------------------------------------------------------------------------

/**
 * Solve for VNA error terms given measured reflection coefficients for known standards.
 *
 * Supported calTypes:
 *   "OSL" : full 3-term (Open, Short, Load) → solves e00, e11, e10e01
 *   "OS"  : 2-term using Open + Short; Load assumed ideal (e00=0)
 *   "OL"  : 2-term using Open + Load
 *   "SL"  : 2-term using Short + Load
 *   "O"   : 1-term (Open only); e00 = Γm_open − 1, e10e01 = 1, e11 = 0
 *   "S"   : 1-term (Short only)
 *   "L"   : 1-term (Load only); e00 = Γm_load, e10e01 = 1, e11 = 0
 *
 * @param {{
 *   open?: {measured:{real,imaginary}, actual:{real,imaginary}},
 *   short?: {measured:{real,imaginary}, actual:{real,imaginary}},
 *   load?: {measured:{real,imaginary}, actual:{real,imaginary}}
 * }} standards - measured and actual (model) Γ for each standard
 * @param {string} calType - one of "OSL","OS","OL","SL","O","S","L"
 * @returns {{e00:{real,imaginary}, e11:{real,imaginary}, e10e01:{real,imaginary}}}
 */
export function computeErrorTerms(standards, calType) {
  const type = (calType || "OSL").toUpperCase();

  if (type === "OSL") {
    return _solveThreeTerm(standards.open, standards.short, standards.load);
  } else if (type === "OS") {
    // Assume load is ideal (measured = 0)
    const idealLoad = {
      measured: { real: 0, imaginary: 0 },
      actual: { real: 0, imaginary: 0 },
    };
    return _solveThreeTerm(standards.open, standards.short, idealLoad);
  } else if (type === "OL") {
    const idealShort = {
      measured: { real: -1, imaginary: 0 },
      actual: { real: -1, imaginary: 0 },
    };
    return _solveThreeTerm(standards.open, idealShort, standards.load);
  } else if (type === "SL") {
    const idealOpen = {
      measured: { real: 1, imaginary: 0 },
      actual: { real: 1, imaginary: 0 },
    };
    return _solveThreeTerm(idealOpen, standards.short, standards.load);
  } else if (type === "O") {
    // 1-term: only directivity corrected from Open
    const m = standards.open.measured;
    const a = standards.open.actual;
    const e00 = complex_subtract(m, a); // approximate directivity offset
    return {
      e00,
      e11: { real: 0, imaginary: 0 },
      e10e01: { real: 1, imaginary: 0 },
    };
  } else if (type === "S") {
    const m = standards.short.measured;
    const a = standards.short.actual;
    const e00 = complex_subtract(m, a);
    return {
      e00,
      e11: { real: 0, imaginary: 0 },
      e10e01: { real: 1, imaginary: 0 },
    };
  } else if (type === "L") {
    // Load: e00 = measured (assuming actual Γ_load = 0)
    return {
      e00: { ...standards.load.measured },
      e11: { real: 0, imaginary: 0 },
      e10e01: { real: 1, imaginary: 0 },
    };
  }

  // Fallback: identity (no correction)
  return {
    e00: { real: 0, imaginary: 0 },
    e11: { real: 0, imaginary: 0 },
    e10e01: { real: 1, imaginary: 0 },
  };
}

/**
 * Internal: solve the 3-term SOLT system given three standards.
 *
 * For each standard we have: Γm = e00 + e10e01·Γa / (1 − e11·Γa)
 * Rearranging: Γm − e00 − e11·Γm·Γa + e00·e11·Γa = e10e01·Γa
 * Let x=[e00, e11, e10e01], and build 3×3 system.
 */
function _solveThreeTerm(s_open, s_short, s_load) {
  // Build system Ax = b for x = [e00, e11*e10e01, e10e01]
  // The three-term error model can be solved by the 8-term formulation reduced to 1-port:
  //   Γm = (e00 + (e10e01 − e00·e11)·Γa) / (1 − e11·Γa)
  // Cross-multiplying: Γm·(1 − e11·Γa) = e00 + (e10e01 − e00·e11)·Γa
  // This is a linear system in [e00, e11, e10e01]:
  //   Γm = e00 + e10e01·Γa − e11·Γm·Γa
  //
  // In matrix form [Γm, −Γm·Γa, Γa] · [e00, e11, e10e01]^T = ... wait,
  // let's rewrite: e00·(1) + e11·(−Γm·Γa) + e10e01·(Γa) = Γm − 0
  // But that's wrong because there's an implicit coupling. Use the standard
  // 3-unknowns formulation: define M = Γm, A = Γa_actual
  //   M(1 − e11·A) = e00 + (e10e01 − e00·e11)·A
  //   M = e00 + e10e01·A − e11·M·A  ... (*)
  // Let a = e00, b = e11, c = e10e01
  //   a + c·A − b·M·A = M   →  1*a − (M*A)*b + A*c = M
  // Three equations for three standards:
  //   [1, −Mo·Ao, Ao] [a]   [Mo]
  //   [1, −Ms·As, As] [b] = [Ms]
  //   [1, −Ml·Al, Al] [c]   [Ml]

  function solveRow(m, a) {
    return [
      { real: 1, imaginary: 0 }, // coefficient of e00
      { real: -m.real * a.real + m.imaginary * a.imaginary, imaginary: -m.real * a.imaginary - m.imaginary * a.real }, // coefficient of e11: −M·A
      a, // coefficient of e10e01: A
      m, // RHS
    ];
  }

  const Mo = s_open.measured;
  const Ao = s_open.actual;
  const Ms = s_short.measured;
  const As = s_short.actual;
  const Ml = s_load.measured;
  const Al = s_load.actual;

  const r0 = solveRow(Mo, Ao);
  const r1 = solveRow(Ms, As);
  const r2 = solveRow(Ml, Al);

  // Solve 3×3 complex system using Cramer's rule
  const [e00, e11, e10e01] = _solveCramer3x3(
    [r0[0], r0[1], r0[2]],
    [r1[0], r1[1], r1[2]],
    [r2[0], r2[1], r2[2]],
    [r0[3], r1[3], r2[3]],
  );
  return { e00, e11, e10e01 };
}

/**
 * Solve 3×3 complex linear system [A]x = b using Cramer's rule.
 * Each row of A is [c0, c1, c2] (complex), b is [b0, b1, b2] (complex).
 */
function _solveCramer3x3(row0, row1, row2, rhs) {
  const det3 = (a, b, c, d, e, f, g, h, i) => {
    // det of [[a,b,c],[d,e,f],[g,h,i]]
    const t0 = complex_subtract(complex_multiply(e, i), complex_multiply(f, h));
    const t1 = complex_subtract(complex_multiply(d, i), complex_multiply(f, g));
    const t2 = complex_subtract(complex_multiply(d, h), complex_multiply(e, g));
    return complex_subtract(complex_add(complex_multiply(a, t0), complex_multiply(c, t2)), complex_multiply(b, t1));
  };

  const D = det3(row0[0], row0[1], row0[2], row1[0], row1[1], row1[2], row2[0], row2[1], row2[2]);
  const D0 = det3(rhs[0], row0[1], row0[2], rhs[1], row1[1], row1[2], rhs[2], row2[1], row2[2]);
  const D1 = det3(row0[0], rhs[0], row0[2], row1[0], rhs[1], row1[2], row2[0], rhs[2], row2[2]);
  const D2 = det3(row0[0], row0[1], rhs[0], row1[0], row1[1], rhs[1], row2[0], row2[1], rhs[2]);

  const Dinv = one_over_complex(D);
  return [complex_multiply(D0, Dinv), complex_multiply(D1, Dinv), complex_multiply(D2, Dinv)];
}

// ---------------------------------------------------------------------------
// Apply calibration correction
// ---------------------------------------------------------------------------

/**
 * Apply 3-term error correction to a raw (measured) S11.
 * Γ_corrected = (Γm − e00) / (e11·(Γm − e00) + e10e01)
 *
 * @param {{real:number,imaginary:number}} rawS11 - measured S11 (rectangular)
 * @param {{e00,e11,e10e01}} errorTerms
 * @returns {{real:number,imaginary:number}} corrected S11
 */
export function applyCalibration(rawS11, errorTerms) {
  const { e00, e11, e10e01 } = errorTerms;
  const numerator = complex_subtract(rawS11, e00);
  const denominator = complex_add(complex_multiply(e11, numerator), e10e01);
  return complex_multiply(numerator, one_over_complex(denominator));
}

// ---------------------------------------------------------------------------
// Calibration-plane shift
// ---------------------------------------------------------------------------

/**
 * Shift the calibration plane by a physical transmission-line offset.
 * This multiplies the reflection tracking term by e^{−2jβℓ}:
 *   e10e01_new = e10e01 · e^{−2jβℓ}
 * where β = 2π·f·√εeff / c
 *
 * @param {{e00,e11,e10e01}} errorTerms
 * @param {number} length - physical length (metres)
 * @param {number} zo - characteristic impedance (Ω) — unused for electrical offset but kept for API
 * @param {number} eeff - effective dielectric constant
 * @param {number} frequency - frequency in Hz
 * @returns {{e00,e11,e10e01}} shifted error terms
 */
export function moveCalPlane(errorTerms, length, zo, eeff, frequency) {
  void zo; // zo does not alter the phase shift magnitude, kept for clarity
  const beta = (2 * Math.PI * frequency * Math.sqrt(eeff)) / speedOfLight;
  const theta = 2 * beta * length; // total electrical length (2-way)
  const phasor = {
    real: Math.cos(-theta),
    imaginary: Math.sin(-theta),
  };
  return {
    e00: { ...errorTerms.e00 },
    e11: { ...errorTerms.e11 },
    e10e01: complex_multiply(errorTerms.e10e01, phasor),
  };
}

// ---------------------------------------------------------------------------
// Apply calibration to a full frequency-keyed s-param data object
// ---------------------------------------------------------------------------

/**
 * Apply SOLT calibration correction to all frequency points in sparamData.
 * If calSettings.useIdeal is true, uses ideal standard models; otherwise uses
 * user-supplied realistic model parameters to compute per-frequency gamma_actual.
 *
 * @param {Object} sparamData - frequency-keyed s-param data (as produced by parseTouchstoneFile)
 * @param {{
 *   enabled: boolean,
 *   calType: string,
 *   useIdeal: boolean,
 *   standards: {open:{measured}, short:{measured}, load:{measured},
 *               openParams, shortParams, loadParams},
 *   planeLength: number,
 *   planeZo: number,
 *   planeEeff: number
 * }} calSettings
 * @param {number} zo - reference impedance
 * @returns {Object} corrected frequency-keyed s-param data
 */
export function applyCalibrationToDataset(sparamData, calSettings, zo) {
  if (!calSettings || !calSettings.enabled) return sparamData;

  const result = {};
  for (const fStr in sparamData) {
    const f = Number(fStr);
    const point = sparamData[fStr];

    // Build standard models at this frequency
    let openActual, shortActual, loadActual;
    if (calSettings.useIdeal) {
      openActual = idealStandards.open;
      shortActual = idealStandards.short;
      loadActual = idealStandards.load;
    } else {
      openActual = realisticOpenGamma(f, zo, calSettings.standards?.openParams || {});
      shortActual = realisticShortGamma(f, zo, calSettings.standards?.shortParams || {});
      loadActual = realisticLoadGamma(f, zo, calSettings.standards?.loadParams || {});
    }

    // Use the measured standard responses (user-entered or synthesized from the model).
    // For a teaching tool we synthesize measured = actual + no error (perfect measurement)
    // unless the user provides specific measured values.
    const standards = {
      open: {
        measured: calSettings.standards?.openMeasured ? polarToRectangular(calSettings.standards.openMeasured) : openActual,
        actual: openActual,
      },
      short: {
        measured: calSettings.standards?.shortMeasured ? polarToRectangular(calSettings.standards.shortMeasured) : shortActual,
        actual: shortActual,
      },
      load: {
        measured: calSettings.standards?.loadMeasured ? polarToRectangular(calSettings.standards.loadMeasured) : loadActual,
        actual: loadActual,
      },
    };

    let errorTerms = computeErrorTerms(standards, calSettings.calType);

    // Optionally shift calibration plane
    if (calSettings.planeLength && calSettings.planeLength !== 0) {
      errorTerms = moveCalPlane(errorTerms, calSettings.planeLength, calSettings.planeZo || zo, calSettings.planeEeff || 1, f);
    }

    const rawS11Polar = point.S11;
    const rawS11Rect = polarToRectangular(rawS11Polar);
    const correctedRect = applyCalibration(rawS11Rect, errorTerms);
    const correctedPolar = rectangularToPolar(correctedRect);

    result[fStr] = { ...point, S11: correctedPolar };
  }
  return result;
}
