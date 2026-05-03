import { expect, test, describe } from "vitest";
import { sToT, tToS, deembedSparams, embedSparams, tLineFixtureTMatrix } from "../src/deembedding.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function mkPolar(magnitude, angle_deg) {
  return { magnitude, angle: angle_deg };
}

function mkIdeal2Port(s11, s21, s12, s22) {
  return { S11: mkPolar(...s11), S21: mkPolar(...s21), S12: mkPolar(...s12), S22: mkPolar(...s22) };
}

function nearlyZero(c, tol = 1e-6) {
  return Math.sqrt(c.real ** 2 + c.imaginary ** 2) < tol;
}

// ---------------------------------------------------------------------------
// S ↔ T conversion round-trip
// ---------------------------------------------------------------------------
describe("S ↔ T conversion round-trip", () => {
  const sp = mkIdeal2Port([0.1, 10], [0.9, -30], [0.9, -30], [0.1, 10]);

  test("T → S → T round-trip preserves S11 magnitude", () => {
    const T = sToT(sp);
    const sBack = tToS(T);
    expect(Math.sqrt(sBack.S11.real ** 2 + sBack.S11.imaginary ** 2)).toBeCloseTo(0.1, 5);
  });

  test("T → S → T round-trip preserves S21 magnitude", () => {
    const T = sToT(sp);
    const sBack = tToS(T);
    expect(Math.sqrt(sBack.S21.real ** 2 + sBack.S21.imaginary ** 2)).toBeCloseTo(0.9, 5);
  });
});

// ---------------------------------------------------------------------------
// Ideal T-line fixture: de-embedding removes the line phase
// ---------------------------------------------------------------------------
describe("T-line fixture de-embedding", () => {
  const f = 2e9;
  const len = 0.05; // 5 cm
  const eeff = 1;

  // Build a thru measurement through the T-line: S21=e^{-jβℓ}, S11=S22=0
  function buildThru() {
    const T = tLineFixtureTMatrix(len, eeff, f);
    const s = tToS(T);
    // Convert rectangular to polar for the API
    const mag21 = Math.sqrt(s.S21.real ** 2 + s.S21.imaginary ** 2);
    const ang21 = Math.atan2(s.S21.imaginary, s.S21.real) * 180 / Math.PI;
    const mag11 = Math.sqrt(s.S11.real ** 2 + s.S11.imaginary ** 2);
    const ang11 = Math.atan2(s.S11.imaginary, s.S11.real) * 180 / Math.PI;
    return {
      S11: mkPolar(mag11, ang11),
      S22: mkPolar(mag11, ang11),
      S21: mkPolar(mag21, ang21),
      S12: mkPolar(mag21, ang21),
    };
  }

  // A DUT: some reflective device
  const dutSp = mkIdeal2Port([0.2, 45], [0.8, -90], [0.8, -90], [0.2, 45]);

  test("de-embedding of thru gives back identity", () => {
    const thru = buildThru();
    // Embed DUT in the T-line
    const embedded = embedSparams(dutSp, thru);
    // De-embed should recover DUT
    const embeddedPolar = {
      S11: { magnitude: Math.sqrt(embedded.S11.real ** 2 + embedded.S11.imaginary ** 2), angle: Math.atan2(embedded.S11.imaginary, embedded.S11.real) * 180 / Math.PI },
      S21: { magnitude: Math.sqrt(embedded.S21.real ** 2 + embedded.S21.imaginary ** 2), angle: Math.atan2(embedded.S21.imaginary, embedded.S21.real) * 180 / Math.PI },
      S12: { magnitude: Math.sqrt(embedded.S12.real ** 2 + embedded.S12.imaginary ** 2), angle: Math.atan2(embedded.S12.imaginary, embedded.S12.real) * 180 / Math.PI },
      S22: { magnitude: Math.sqrt(embedded.S22.real ** 2 + embedded.S22.imaginary ** 2), angle: Math.atan2(embedded.S22.imaginary, embedded.S22.real) * 180 / Math.PI },
    };
    const recovered = deembedSparams(embeddedPolar, thru);
    // S11 real part should match DUT
    const dutS11 = dutSp.S11.magnitude * Math.cos(dutSp.S11.angle * Math.PI / 180);
    expect(recovered.S11.real).toBeCloseTo(dutS11, 4);
  });

  test("embed then de-embed roundtrip preserves |S21|", () => {
    const thru = buildThru();
    const embedded = embedSparams(dutSp, thru);
    const embeddedPolar = {
      S11: { magnitude: Math.sqrt(embedded.S11.real ** 2 + embedded.S11.imaginary ** 2), angle: Math.atan2(embedded.S11.imaginary, embedded.S11.real) * 180 / Math.PI },
      S21: { magnitude: Math.sqrt(embedded.S21.real ** 2 + embedded.S21.imaginary ** 2), angle: Math.atan2(embedded.S21.imaginary, embedded.S21.real) * 180 / Math.PI },
      S12: { magnitude: Math.sqrt(embedded.S12.real ** 2 + embedded.S12.imaginary ** 2), angle: Math.atan2(embedded.S12.imaginary, embedded.S12.real) * 180 / Math.PI },
      S22: { magnitude: Math.sqrt(embedded.S22.real ** 2 + embedded.S22.imaginary ** 2), angle: Math.atan2(embedded.S22.imaginary, embedded.S22.real) * 180 / Math.PI },
    };
    const recovered = deembedSparams(embeddedPolar, thru);
    const mag21 = Math.sqrt(recovered.S21.real ** 2 + recovered.S21.imaginary ** 2);
    expect(mag21).toBeCloseTo(dutSp.S21.magnitude, 4);
  });
});

// ---------------------------------------------------------------------------
// Asymmetric fixture: different port-1 and port-2 fixtures
// ---------------------------------------------------------------------------
describe("Asymmetric fixture de-embedding", () => {
  const f = 1e9;
  const fix1 = tLineFixtureTMatrix(0.03, 1, f);
  const fix2 = tLineFixtureTMatrix(0.07, 1, f);
  const fix1Sp = (() => {
    const s = tToS(fix1);
    return {
      S11: { magnitude: Math.sqrt(s.S11.real ** 2 + s.S11.imaginary ** 2), angle: Math.atan2(s.S11.imaginary, s.S11.real) * 180 / Math.PI },
      S21: { magnitude: Math.sqrt(s.S21.real ** 2 + s.S21.imaginary ** 2), angle: Math.atan2(s.S21.imaginary, s.S21.real) * 180 / Math.PI },
      S12: { magnitude: Math.sqrt(s.S12.real ** 2 + s.S12.imaginary ** 2), angle: Math.atan2(s.S12.imaginary, s.S12.real) * 180 / Math.PI },
      S22: { magnitude: Math.sqrt(s.S22.real ** 2 + s.S22.imaginary ** 2), angle: Math.atan2(s.S22.imaginary, s.S22.real) * 180 / Math.PI },
    };
  })();
  const fix2Sp = (() => {
    const s = tToS(fix2);
    return {
      S11: { magnitude: Math.sqrt(s.S11.real ** 2 + s.S11.imaginary ** 2), angle: Math.atan2(s.S11.imaginary, s.S11.real) * 180 / Math.PI },
      S21: { magnitude: Math.sqrt(s.S21.real ** 2 + s.S21.imaginary ** 2), angle: Math.atan2(s.S21.imaginary, s.S21.real) * 180 / Math.PI },
      S12: { magnitude: Math.sqrt(s.S12.real ** 2 + s.S12.imaginary ** 2), angle: Math.atan2(s.S12.imaginary, s.S12.real) * 180 / Math.PI },
      S22: { magnitude: Math.sqrt(s.S22.real ** 2 + s.S22.imaginary ** 2), angle: Math.atan2(s.S22.imaginary, s.S22.real) * 180 / Math.PI },
    };
  })();

  const dutSp = mkIdeal2Port([0.15, 30], [0.85, -60], [0.85, -60], [0.15, 30]);

  test("asymmetric embed/de-embed roundtrip recovers DUT S11", () => {
    const embedded = embedSparams(dutSp, fix1Sp, fix2Sp);
    const embPolar = {
      S11: { magnitude: Math.sqrt(embedded.S11.real ** 2 + embedded.S11.imaginary ** 2), angle: Math.atan2(embedded.S11.imaginary, embedded.S11.real) * 180 / Math.PI },
      S21: { magnitude: Math.sqrt(embedded.S21.real ** 2 + embedded.S21.imaginary ** 2), angle: Math.atan2(embedded.S21.imaginary, embedded.S21.real) * 180 / Math.PI },
      S12: { magnitude: Math.sqrt(embedded.S12.real ** 2 + embedded.S12.imaginary ** 2), angle: Math.atan2(embedded.S12.imaginary, embedded.S12.real) * 180 / Math.PI },
      S22: { magnitude: Math.sqrt(embedded.S22.real ** 2 + embedded.S22.imaginary ** 2), angle: Math.atan2(embedded.S22.imaginary, embedded.S22.real) * 180 / Math.PI },
    };
    const recovered = deembedSparams(embPolar, fix1Sp, fix2Sp);
    const dutS11r = dutSp.S11.magnitude * Math.cos(dutSp.S11.angle * Math.PI / 180);
    expect(recovered.S11.real).toBeCloseTo(dutS11r, 4);
  });
});
