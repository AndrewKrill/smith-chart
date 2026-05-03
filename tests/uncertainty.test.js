import { expect, test, describe } from "vitest";
import { computeUncertaintyBands, uncertaintyAtPoint, computeResidualErrors } from "../src/uncertainty.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function mkSpData(freqs, gamma = 0.3) {
  const data = {};
  for (const f of freqs) {
    data[f.toString()] = { S11: { magnitude: gamma, angle: 0 } };
  }
  return data;
}

// ---------------------------------------------------------------------------
// uncertaintyAtPoint
// ---------------------------------------------------------------------------
describe("uncertaintyAtPoint", () => {
  test("returns zero calibration residuals for ideal standards", () => {
    const { Ed, Es, Et } = uncertaintyAtPoint(0.3, 1e9, 50, {
      noiseFloor_dB: -80,
      repeatability_dB: -60,
      useIdeal: true,
    });
    expect(Ed).toBe(0);
    expect(Es).toBe(0);
    expect(Et).toBe(0);
  });

  test("deltaGamma includes noise floor contribution", () => {
    const noiseFloor_dB = -40; // 10^(-40/20) = 0.01
    const { deltaGamma, noise_G } = uncertaintyAtPoint(0, 1e9, 50, {
      noiseFloor_dB,
      repeatability_dB: -100,
      useIdeal: true,
    });
    expect(noise_G).toBeCloseTo(0.01, 4);
    expect(deltaGamma).toBeGreaterThanOrEqual(noise_G);
  });

  test("deltaGamma increases with higher gamma magnitude (source match term)", () => {
    // Use realistic Short with residual inductance to create non-zero Es/Et
    // This makes terms scale with gammaMag^2 and gammaMag respectively
    const settings = {
      noiseFloor_dB: -100,
      repeatability_dB: -100,
      useIdeal: false,
      realisticParams: { shortParams: { l0: 500e-12 } },
    };
    const low = uncertaintyAtPoint(0.01, 2e9, 50, settings);
    const high = uncertaintyAtPoint(0.99, 2e9, 50, settings);
    expect(high.deltaGamma).toBeGreaterThan(low.deltaGamma);
  });

  test("repeatability always included in deltaGamma", () => {
    const repeatability_dB = -40; // 0.01
    const { deltaGamma, repeat_G } = uncertaintyAtPoint(0, 1e9, 50, {
      noiseFloor_dB: -100,
      repeatability_dB,
      useIdeal: true,
    });
    expect(repeat_G).toBeCloseTo(0.01, 4);
    expect(deltaGamma).toBeGreaterThanOrEqual(repeat_G);
  });
});

// ---------------------------------------------------------------------------
// computeResidualErrors
// ---------------------------------------------------------------------------
describe("computeResidualErrors", () => {
  test("returns zero for ideal-matching parameters (all zeros)", () => {
    const { Ed, Es, Et } = computeResidualErrors(1e9, 50, {});
    expect(Ed).toBe(0);
    expect(Es).toBe(0);
    expect(Et).toBe(0);
  });

  test("non-zero load offset gives non-zero Ed (directivity)", () => {
    const { Ed } = computeResidualErrors(1e9, 50, { loadParams: { r_offset: 5 } });
    expect(Ed).toBeGreaterThan(0);
  });

  test("residual errors scale with frequency for inductive short", () => {
    const low = computeResidualErrors(1e9, 50, { shortParams: { l0: 100e-12 } });
    const high = computeResidualErrors(10e9, 50, { shortParams: { l0: 100e-12 } });
    expect(high.Es).toBeGreaterThan(low.Es);
  });
});

// ---------------------------------------------------------------------------
// computeUncertaintyBands
// ---------------------------------------------------------------------------
describe("computeUncertaintyBands", () => {
  const freqs = [1e9, 2e9, 3e9, 4e9];
  const spData = mkSpData(freqs, 0.3);

  test("returns empty arrays when disabled", () => {
    const bands = computeUncertaintyBands(spData, 50, { enabled: false });
    expect(bands.freqs.length).toBe(0);
  });

  test("returns correct number of frequency points", () => {
    const bands = computeUncertaintyBands(spData, 50, {
      enabled: true,
      noiseFloor_dB: -80,
      repeatability_dB: -60,
      useIdeal: true,
    });
    expect(bands.freqs.length).toBe(freqs.length);
  });

  test("upper_dB > s11_mag_dB for all points", () => {
    const bands = computeUncertaintyBands(spData, 50, {
      enabled: true,
      noiseFloor_dB: -80,
      repeatability_dB: -60,
      useIdeal: true,
    });
    for (let i = 0; i < bands.freqs.length; i++) {
      expect(bands.upper_dB[i]).toBeGreaterThan(bands.s11_mag_dB[i]);
    }
  });

  test("lower_dB < s11_mag_dB for all points", () => {
    const bands = computeUncertaintyBands(spData, 50, {
      enabled: true,
      noiseFloor_dB: -80,
      repeatability_dB: -60,
      useIdeal: true,
    });
    for (let i = 0; i < bands.freqs.length; i++) {
      expect(bands.lower_dB[i]).toBeLessThan(bands.s11_mag_dB[i]);
    }
  });

  test("maxUncertainty_dB is reported as a positive number", () => {
    const bands = computeUncertaintyBands(spData, 50, {
      enabled: true,
      noiseFloor_dB: -40,
      repeatability_dB: -40,
      useIdeal: true,
    });
    expect(bands.maxUncertainty_dB).toBeGreaterThan(0);
  });

  test("dominantSource is one of the expected keys", () => {
    const bands = computeUncertaintyBands(spData, 50, {
      enabled: true,
      noiseFloor_dB: -40,
      repeatability_dB: -40,
      useIdeal: false,
      realisticParams: { loadParams: { r_offset: 2 } },
    });
    const validSources = ["directivity", "sourceMatch", "tracking", "noise", "repeatability"];
    expect(validSources).toContain(bands.dominantSource);
  });

  test("higher noise floor increases maxUncertainty_dB", () => {
    const lowNoise = computeUncertaintyBands(spData, 50, { enabled: true, noiseFloor_dB: -80, repeatability_dB: -80, useIdeal: true });
    const highNoise = computeUncertaintyBands(spData, 50, { enabled: true, noiseFloor_dB: -20, repeatability_dB: -80, useIdeal: true });
    expect(highNoise.maxUncertainty_dB).toBeGreaterThan(lowNoise.maxUncertainty_dB);
  });
});
