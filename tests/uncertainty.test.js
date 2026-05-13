import { expect, test, describe } from "vitest";
import {
  computeUncertaintyBands,
  uncertaintyAtPoint,
  computeResidualErrors,
  computeCalibrationPathAttenuation_dB,
  computeNoiseScaling_dB,
} from "../src/uncertainty.js";

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

  test("higher IF bandwidth increases effective noise", () => {
    const lowIfbw = uncertaintyAtPoint(0, 1e9, 50, {
      noiseFloor_dB: -60,
      repeatability_dB: -120,
      ifBandwidthHz: 100,
      averagingEnabled: false,
      useIdeal: true,
    });
    const highIfbw = uncertaintyAtPoint(0, 1e9, 50, {
      noiseFloor_dB: -60,
      repeatability_dB: -120,
      ifBandwidthHz: 10000,
      averagingEnabled: false,
      useIdeal: true,
    });
    expect(highIfbw.noise_G).toBeGreaterThan(lowIfbw.noise_G);
  });

  test("averaging reduces effective noise when enabled", () => {
    const noAvg = uncertaintyAtPoint(0, 1e9, 50, {
      noiseFloor_dB: -60,
      repeatability_dB: -120,
      ifBandwidthHz: 1000,
      averagingEnabled: false,
      averagingCount: 16,
      useIdeal: true,
    });
    const avg = uncertaintyAtPoint(0, 1e9, 50, {
      noiseFloor_dB: -60,
      repeatability_dB: -120,
      ifBandwidthHz: 1000,
      averagingEnabled: true,
      averagingCount: 16,
      useIdeal: true,
    });
    expect(avg.noise_G).toBeLessThan(noAvg.noise_G);
  });
});

describe("computeNoiseScaling_dB", () => {
  test("is neutral at reference IFBW with averaging disabled", () => {
    const out = computeNoiseScaling_dB({
      noiseFloor_dB: -60,
      ifBandwidthHz: 1000,
      averagingEnabled: false,
      averagingCount: 32,
    });
    expect(out.netAdjustment_dB).toBeCloseTo(0, 8);
    expect(out.effectiveNoiseFloor_dB).toBeCloseTo(-60, 8);
  });

  test("clamps invalid averagingCount to 1 when averaging is enabled", () => {
    const out = computeNoiseScaling_dB({
      noiseFloor_dB: -60,
      ifBandwidthHz: 1000,
      averagingEnabled: true,
      averagingCount: 0,
    });
    expect(out.averagingCount).toBe(1);
    expect(out.netAdjustment_dB).toBeCloseTo(0, 8);
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
    const validSources = ["directivity", "sourceMatch", "tracking", "noise", "repeatability", "pathAttenuation"];
    expect(validSources).toContain(bands.dominantSource);
  });

  test("higher noise floor increases maxUncertainty_dB", () => {
    const lowNoise = computeUncertaintyBands(spData, 50, { enabled: true, noiseFloor_dB: -80, repeatability_dB: -80, useIdeal: true });
    const highNoise = computeUncertaintyBands(spData, 50, { enabled: true, noiseFloor_dB: -20, repeatability_dB: -80, useIdeal: true });
    expect(highNoise.maxUncertainty_dB).toBeGreaterThan(lowNoise.maxUncertainty_dB);
  });

  test("returns phase and |Z| uncertainty envelopes", () => {
    const bands = computeUncertaintyBands(spData, 50, {
      enabled: true,
      noiseFloor_dB: -60,
      repeatability_dB: -50,
      useIdeal: true,
    });

    expect(bands.phase_upper_deg.length).toBe(freqs.length);
    expect(bands.phase_lower_deg.length).toBe(freqs.length);
    expect(bands.z_upper_ohm.length).toBe(freqs.length);
    expect(bands.z_lower_ohm.length).toBe(freqs.length);

    for (let i = 0; i < freqs.length; i++) {
      expect(bands.phase_upper_deg[i]).toBeGreaterThanOrEqual(bands.s11_phase_deg[i]);
      expect(bands.phase_lower_deg[i]).toBeLessThanOrEqual(bands.s11_phase_deg[i]);
      expect(bands.z_upper_ohm[i]).toBeGreaterThanOrEqual(bands.z_mag_ohm[i]);
      expect(bands.z_lower_ohm[i]).toBeLessThanOrEqual(bands.z_mag_ohm[i]);
    }
  });
});

describe("computeCalibrationPathAttenuation_dB", () => {
  test("captures ESR-bearing capacitor contribution", () => {
    const freqs = [1e8, 1e9, 2e9];
    const path = [{ name: "seriesCap", value: 1, unit: "pF", esr: 5, esl: 0 }];
    const attenuation = computeCalibrationPathAttenuation_dB(path, freqs, 50);
    expect(attenuation.length).toBe(freqs.length);
    expect(Math.max(...attenuation)).toBeGreaterThan(0);
  });

  test("captures frequency response from quarter-wave open stub", () => {
    const freqs = [5e8, 7.5e8, 1e9, 1.25e9, 1.5e9];
    const path = [{ name: "stub", value: 75, unit: "mm", zo: 50, eeff: 1 }];
    const attenuation = computeCalibrationPathAttenuation_dB(path, freqs, 50);
    expect(attenuation.length).toBe(freqs.length);
    const spread = Math.max(...attenuation) - Math.min(...attenuation);
    expect(spread).toBeGreaterThan(0.01);
  });
});
