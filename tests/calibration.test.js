import { expect, test, describe } from "vitest";
import { computeErrorTerms, applyCalibration, moveCalPlane, idealStandards, realisticOpenGamma, realisticShortGamma, realisticLoadGamma } from "../src/calibration.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function cplx(r, i) { return { real: r, imaginary: i }; }
function mag(c) { return Math.sqrt(c.real ** 2 + c.imaginary ** 2); }
function nearlyEqual(a, b, tol = 1e-6) { return Math.abs(a - b) < tol; }

// ---------------------------------------------------------------------------
// OSL with known synthetic error terms
// ---------------------------------------------------------------------------
describe("OSL calibration — synthetic error terms", () => {
  // Inject known error terms and build simulated measured standards:
  //   Γm = e00 + e10e01·Γa / (1 − e11·Γa)
  const e00 = cplx(0.05, 0.02);     // directivity
  const e11 = cplx(0.08, -0.03);    // source match
  const e10e01 = cplx(0.95, -0.04); // reflection tracking

  // Simulate measured Γ from the HP/standard form:
  //   Γm = e00 + e10e01·Γa / (1 − e11·Γa)
  function simulateMeasured(gamma_actual) {
    const { real: re, imaginary: im } = gamma_actual;
    // numerator of the fraction: e10e01·Γa
    const fracNR = e10e01.real * re - e10e01.imaginary * im;
    const fracNI = e10e01.real * im + e10e01.imaginary * re;
    // denominator: 1 - e11·Γa
    const denRe = 1 - (e11.real * re - e11.imaginary * im);
    const denIm = -(e11.real * im + e11.imaginary * re);
    const mag2 = denRe * denRe + denIm * denIm;
    // fraction = e10e01·Γa / (1 − e11·Γa)
    const fracRe = (fracNR * denRe + fracNI * denIm) / mag2;
    const fracIm = (fracNI * denRe - fracNR * denIm) / mag2;
    // Γm = e00 + fraction
    return cplx(e00.real + fracRe, e00.imaginary + fracIm);
  }

  const openMeas = simulateMeasured(idealStandards.open);
  const shortMeas = simulateMeasured(idealStandards.short);
  const loadMeas = simulateMeasured(idealStandards.load);

  const standards = {
    open:  { measured: openMeas,  actual: idealStandards.open },
    short: { measured: shortMeas, actual: idealStandards.short },
    load:  { measured: loadMeas,  actual: idealStandards.load },
  };

  test("computeErrorTerms recovers e00 correctly", () => {
    const et = computeErrorTerms(standards, "OSL");
    expect(et.e00.real).toBeCloseTo(e00.real, 5);
    expect(et.e00.imaginary).toBeCloseTo(e00.imaginary, 5);
  });

  test("computeErrorTerms recovers e11 correctly", () => {
    const et = computeErrorTerms(standards, "OSL");
    expect(et.e11.real).toBeCloseTo(e11.real, 5);
    expect(et.e11.imaginary).toBeCloseTo(e11.imaginary, 5);
  });

  test("computeErrorTerms recovers e10e01 correctly", () => {
    const et = computeErrorTerms(standards, "OSL");
    expect(et.e10e01.real).toBeCloseTo(e10e01.real, 5);
    expect(et.e10e01.imaginary).toBeCloseTo(e10e01.imaginary, 5);
  });

  test("applyCalibration corrects a known DUT to ideal", () => {
    const gammaDut = cplx(0.3, 0.4);
    const gammaMeas = simulateMeasured(gammaDut);
    const et = computeErrorTerms(standards, "OSL");
    const corrected = applyCalibration(gammaMeas, et);
    expect(corrected.real).toBeCloseTo(gammaDut.real, 5);
    expect(corrected.imaginary).toBeCloseTo(gammaDut.imaginary, 5);
  });

  test("applyCalibration: corrected Load ≈ 0", () => {
    const et = computeErrorTerms(standards, "OSL");
    const corrected = applyCalibration(loadMeas, et);
    expect(mag(corrected)).toBeCloseTo(0, 5);
  });

  test("applyCalibration: corrected Open ≈ +1", () => {
    const et = computeErrorTerms(standards, "OSL");
    const corrected = applyCalibration(openMeas, et);
    expect(corrected.real).toBeCloseTo(1, 5);
    expect(corrected.imaginary).toBeCloseTo(0, 5);
  });

  test("applyCalibration: corrected Short ≈ -1", () => {
    const et = computeErrorTerms(standards, "OSL");
    const corrected = applyCalibration(shortMeas, et);
    expect(corrected.real).toBeCloseTo(-1, 5);
    expect(corrected.imaginary).toBeCloseTo(0, 5);
  });
});

// ---------------------------------------------------------------------------
// Calibration-plane shift
// ---------------------------------------------------------------------------
describe("moveCalPlane", () => {
  const identityTerms = {
    e00: cplx(0, 0),
    e11: cplx(0, 0),
    e10e01: cplx(1, 0),
  };

  test("zero length produces no phase shift", () => {
    const c = 299792458;
    const shifted = moveCalPlane(identityTerms, 0, 50, 1, 1e9);
    expect(shifted.e10e01.real).toBeCloseTo(1, 10);
    expect(shifted.e10e01.imaginary).toBeCloseTo(0, 10);
  });

  test("quarter-wavelength shift rotates e10e01 by 180°", () => {
    const c = 299792458;
    const f = 1e9;
    const eeff = 1;
    // λ/4 = c/(4f) metres
    const len = c / (4 * f);
    const shifted = moveCalPlane(identityTerms, len, 50, eeff, f);
    // Two-way → 180° phase → e^{-jπ} = -1
    expect(shifted.e10e01.real).toBeCloseTo(-1, 4);
    expect(shifted.e10e01.imaginary).toBeCloseTo(0, 4);
  });

  test("half-wavelength shift returns to original", () => {
    const c = 299792458;
    const f = 1e9;
    const eeff = 1;
    const len = c / (2 * f);
    const shifted = moveCalPlane(identityTerms, len, 50, eeff, f);
    expect(shifted.e10e01.real).toBeCloseTo(1, 4);
    expect(shifted.e10e01.imaginary).toBeCloseTo(0, 4);
  });
});

// ---------------------------------------------------------------------------
// Realistic standard models
// ---------------------------------------------------------------------------
describe("Realistic standard models", () => {
  test("ideal open returns Γ=+1 when c0=0", () => {
    const g = realisticOpenGamma(1e9, 50, { c0: 0 });
    expect(g.real).toBeCloseTo(1, 6);
    expect(g.imaginary).toBeCloseTo(0, 6);
  });

  test("realistic open with fringe cap deviates from +1", () => {
    const g = realisticOpenGamma(1e9, 50, { c0: 10e-15 }); // 10 fF
    expect(Math.abs(g.real - 1) + Math.abs(g.imaginary)).toBeGreaterThan(0);
  });

  test("ideal short returns Γ=−1 when l0=0", () => {
    const g = realisticShortGamma(1e9, 50, { l0: 0 });
    expect(g.real).toBeCloseTo(-1, 6);
    expect(g.imaginary).toBeCloseTo(0, 6);
  });

  test("ideal load returns Γ≈0 when r_offset=0", () => {
    const g = realisticLoadGamma(1e9, 50, { r_offset: 0, l_offset: 0 });
    expect(Math.sqrt(g.real ** 2 + g.imaginary ** 2)).toBeCloseTo(0, 6);
  });
});

// ---------------------------------------------------------------------------
// Cal types
// ---------------------------------------------------------------------------
describe("Cal types", () => {
  test("L-only: e00 = measured load", () => {
    const loadMeas = cplx(0.02, 0.01);
    const et = computeErrorTerms({ load: { measured: loadMeas, actual: idealStandards.load } }, "L");
    expect(et.e00.real).toBeCloseTo(loadMeas.real, 8);
    expect(et.e00.imaginary).toBeCloseTo(loadMeas.imaginary, 8);
  });
});
