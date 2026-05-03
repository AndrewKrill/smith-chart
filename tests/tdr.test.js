import { expect, test, describe } from "vitest";
import { frequencyToTimeDomain, applyGate, buildWindow, windowInfo, gateStartStopToCS, gateCsToStartStop } from "../src/tdr.js";

// ---------------------------------------------------------------------------
// Helper: build a synthetic frequency-keyed s-param dataset
// ---------------------------------------------------------------------------
function buildSyntheticSparam(fStart, fStop, nPoints, gammaFn) {
  const data = {};
  for (let i = 0; i < nPoints; i++) {
    const f = fStart + (i / (nPoints - 1)) * (fStop - fStart);
    const { magnitude, angle } = gammaFn(f);
    data[f.toString()] = { S11: { magnitude, angle } };
  }
  return data;
}

// ---------------------------------------------------------------------------
// Window tests
// ---------------------------------------------------------------------------
describe("Window functions", () => {
  test("rectangular window all ones", () => {
    const w = buildWindow(32, "rectangular");
    expect(w.every((v) => v === 1)).toBe(true);
  });

  test("hamming window starts and ends near 0.08", () => {
    const w = buildWindow(64, "hamming");
    expect(w[0]).toBeCloseTo(0.08, 2);
    expect(w[63]).toBeCloseTo(0.08, 2);
  });

  test("hanning window starts and ends near 0", () => {
    const w = buildWindow(64, "hanning");
    expect(w[0]).toBeCloseTo(0, 2);
    expect(w[63]).toBeCloseTo(0, 2);
  });

  test("kaiser6 window has max in middle", () => {
    const N = 65;
    const w = buildWindow(N, "kaiser6");
    const mid = Math.floor(N / 2);
    expect(w[mid]).toBeGreaterThan(w[0]);
    expect(w[mid]).toBeCloseTo(1, 2); // normalised to 1 at center
  });

  test("windowInfo contains all expected windows", () => {
    const expected = ["rectangular", "hamming", "hanning", "blackman", "kaiser6", "kaiser13"];
    for (const w of expected) {
      expect(windowInfo[w]).toBeDefined();
      expect(typeof windowInfo[w].sidelobe_dB).toBe("number");
      expect(windowInfo[w].resolutionFactor).toBeGreaterThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// IFFT round-trip test
// ---------------------------------------------------------------------------
describe("frequencyToTimeDomain", () => {
  // Build a simple dataset: constant |S11| = 0.5, angle = 0 over 1 GHz span
  const fStart = 1e9;
  const fStop = 3e9;
  const N = 64;
  const spData = buildSyntheticSparam(fStart, fStop, N, () => ({ magnitude: 0.5, angle: 0 }));

  test("returns correct number of time points (power of 2)", () => {
    const td = frequencyToTimeDomain(spData, "bandpass", "rectangular");
    expect(td.N).toBeGreaterThan(0);
    expect((td.N & (td.N - 1))).toBe(0); // power of 2
  });

  test("time axis starts at 0", () => {
    const td = frequencyToTimeDomain(spData, "bandpass", "rectangular");
    expect(td.timeAxis[0]).toBe(0);
  });

  test("magnitude array has same length as time axis", () => {
    const td = frequencyToTimeDomain(spData, "bandpass", "rectangular");
    expect(td.magnitude.length).toBe(td.timeAxis.length);
  });

  test("bandpass mode produces non-zero output", () => {
    const td = frequencyToTimeDomain(spData, "bandpass", "rectangular");
    const maxVal = Math.max(...td.magnitude);
    expect(maxVal).toBeGreaterThan(0);
  });

  test("low-pass impulse mode produces a real-valued output (imagPart ≈ 0)", () => {
    const td = frequencyToTimeDomain(spData, "lowpass_impulse", "rectangular");
    // Due to conjugate symmetry, imaginary part should be very small
    const maxIm = Math.max(...td.imagPart.map(Math.abs));
    expect(maxIm).toBeLessThan(1e-9);
  });

  test("low-pass step energy > low-pass impulse energy (cumsum broadens)", () => {
    const tdImp = frequencyToTimeDomain(spData, "lowpass_impulse", "rectangular");
    const tdStep = frequencyToTimeDomain(spData, "lowpass_step", "rectangular");
    const energyImp = tdImp.realPart.reduce((s, v) => s + v * v, 0);
    const energyStep = tdStep.realPart.reduce((s, v) => s + v * v, 0);
    expect(energyStep).toBeGreaterThan(energyImp);
  });

  test("empty dataset returns empty arrays", () => {
    const td = frequencyToTimeDomain({}, "bandpass", "rectangular");
    expect(td.timeAxis.length).toBe(0);
    expect(td.magnitude.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Gate start/stop/center/span consistency
// ---------------------------------------------------------------------------
describe("Gate parameter helpers", () => {
  test("gateStartStopToCS computes center and span correctly", () => {
    const { center, span } = gateStartStopToCS(1e-9, 3e-9);
    expect(center).toBeCloseTo(2e-9, 12);
    expect(span).toBeCloseTo(2e-9, 12);
  });

  test("gateCsToStartStop roundtrip", () => {
    const { tStart, tStop } = gateCsToStartStop(2e-9, 2e-9);
    expect(tStart).toBeCloseTo(1e-9, 12);
    expect(tStop).toBeCloseTo(3e-9, 12);
  });

  test("start/stop → center/span → start/stop roundtrip", () => {
    const origStart = 0.5e-9;
    const origStop = 2.3e-9;
    const { center, span } = gateStartStopToCS(origStart, origStop);
    const { tStart, tStop } = gateCsToStartStop(center, span);
    expect(tStart).toBeCloseTo(origStart, 12);
    expect(tStop).toBeCloseTo(origStop, 12);
  });
});

// ---------------------------------------------------------------------------
// applyGate
// ---------------------------------------------------------------------------
describe("applyGate", () => {
  const fStart = 1e9;
  const fStop = 4e9;
  const N = 128;
  const spData = buildSyntheticSparam(fStart, fStop, N, () => ({ magnitude: 0.5, angle: 0 }));

  test("gate produces gatedTdReal and freqAxis arrays", () => {
    const td = frequencyToTimeDomain(spData, "bandpass", "rectangular");
    const gated = applyGate(td, 0, td.timeAxis[td.timeAxis.length - 1] * 0.25, "nominal");
    expect(gated.gatedTdReal.length).toBeGreaterThan(0);
    expect(gated.freqAxis.length).toBeGreaterThan(0);
  });

  test("gate outside signal range returns near-zero magnitude", () => {
    const td = frequencyToTimeDomain(spData, "bandpass", "rectangular");
    // Gate at a time range that should have no signal
    const farTime = td.timeAxis[td.timeAxis.length - 1];
    const gated = applyGate(td, farTime * 0.95, farTime, "minimum");
    const maxGatedMag = Math.max(...gated.gatedFdMag);
    expect(maxGatedMag).toBeLessThan(1); // arbitrary small threshold
  });

  test("empty tdData returns empty arrays", () => {
    const empty = { timeAxis: [], realPart: [], imagPart: [], fStart: 0, fStop: 0, df: 0, N: 0 };
    const gated = applyGate(empty, 0, 1e-9, "nominal");
    expect(gated.gatedTdReal.length).toBe(0);
    expect(gated.gatedFdMag.length).toBe(0);
  });
});
