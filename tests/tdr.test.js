import { expect, test, describe } from "vitest";
import {
  frequencyToTimeDomain,
  applyGate,
  buildWindow,
  windowInfo,
  gateStartStopToCS,
  gateCsToStartStop,
  gatedToSParamFormat,
  normalizeGateShape,
} from "../src/tdr.js";

function buildSyntheticSparam(fStart, fStop, nPoints, gammaFn) {
  const data = {};
  for (let i = 0; i < nPoints; i++) {
    const f = fStart + (i / (nPoints - 1)) * (fStop - fStart);
    const { magnitude, angle } = gammaFn(f);
    data[f.toString()] = { S11: { magnitude, angle } };
  }
  return data;
}

function buildTwoReflectionSParam(fStart, fStop, nPoints, a1, t1, a2, t2) {
  const data = {};
  for (let i = 0; i < nPoints; i++) {
    const f = fStart + (i / (nPoints - 1)) * (fStop - fStart);
    const w1 = -2 * Math.PI * f * t1;
    const w2 = -2 * Math.PI * f * t2;
    const re = a1 * Math.cos(w1) + a2 * Math.cos(w2);
    const im = a1 * Math.sin(w1) + a2 * Math.sin(w2);
    const mag = Math.sqrt(re * re + im * im);
    const ang = Math.atan2(im, re) * 180 / Math.PI;
    data[f.toString()] = { S11: { magnitude: mag, angle: ang } };
  }
  return data;
}

function nearestIndex(arr, value) {
  let idx = 0;
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < arr.length; i++) {
    const err = Math.abs(arr[i] - value);
    if (err < best) {
      best = err;
      idx = i;
    }
  }
  return idx;
}

describe("Window functions", () => {
  test("rectangular window all ones", () => {
    const w = buildWindow(32, "rectangular");
    expect(w.every((v) => v === 1)).toBe(true);
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

describe("frequencyToTimeDomain", () => {
  const fStart = 1e9;
  const fStop = 3e9;
  const N = 64;
  const spData = buildSyntheticSparam(fStart, fStop, N, () => ({ magnitude: 0.5, angle: 0 }));

  test("returns power-of-two time points and preserves original frequency grid", () => {
    const td = frequencyToTimeDomain(spData, "bandpass", "rectangular");
    expect(td.N).toBeGreaterThan(0);
    expect((td.N & (td.N - 1))).toBe(0);
    expect(td.M).toBe(N);
    expect(td.originalFreqs.length).toBe(N);
  });

  test("rejects invalid low-pass grids instead of silently extrapolating", () => {
    const invalid = buildSyntheticSparam(1e9, 3e9, 64, () => ({ magnitude: 0.2, angle: 0 }));
    const td = frequencyToTimeDomain(invalid, "lowpass_impulse", "rectangular");
    expect(td.valid).toBe(false);
    expect(td.warning).toMatch(/rejected/i);
    expect(td.timeAxis.length).toBe(0);
  });
});

describe("Gate parameter helpers", () => {
  test("start/stop ↔ center/span roundtrip", () => {
    const { center, span } = gateStartStopToCS(1e-9, 3e-9);
    const { tStart, tStop } = gateCsToStartStop(center, span);
    expect(tStart).toBeCloseTo(1e-9, 12);
    expect(tStop).toBeCloseTo(3e-9, 12);
  });
});

describe("applyGate correctness", () => {
  test("full-span gate round-trips original constant S11 (no extra 1/N scaling)", () => {
    const fStart = 1e9;
    const fStop = 4e9;
    const points = 128;
    const spData = buildSyntheticSparam(fStart, fStop, points, () => ({ magnitude: 0.5, angle: 0 }));
    const td = frequencyToTimeDomain(spData, "bandpass", "rectangular");
    const gated = applyGate(td, 0, td.timeAxis[td.timeAxis.length - 1], "normal", "bandpass");

    expect(gated.valid).toBe(true);
    expect(gated.gatedS11.length).toBe(points);
    for (let i = 0; i < gated.gatedS11.length; i++) {
      expect(gated.gatedS11[i].S11.magnitude).toBeCloseTo(0.5, 3);
      expect(gated.gatedS11[i].S11.angle).toBeCloseTo(0, 3);
    }
  });

  test("gated frequency axis matches original measured frequencies", () => {
    const spData = buildSyntheticSparam(1e9, 2e9, 77, () => ({ magnitude: 0.3, angle: 15 }));
    const td = frequencyToTimeDomain(spData, "bandpass", "rectangular");
    const gated = applyGate(td, 0, td.timeAxis[td.timeAxis.length - 1], "normal", "bandpass");
    const original = Object.keys(spData).map(Number).sort((a, b) => a - b);
    expect(gated.freqAxis.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) expect(gated.freqAxis[i]).toBeCloseTo(original[i], 6);
  });

  test("backward compatibility maps nominal gate shape to normal", () => {
    expect(normalizeGateShape("nominal")).toBe("normal");
    const spData = buildSyntheticSparam(1e9, 2e9, 64, () => ({ magnitude: 0.2, angle: 5 }));
    const td = frequencyToTimeDomain(spData, "bandpass", "rectangular");
    const gated = applyGate(td, 0, td.timeAxis[td.timeAxis.length - 1], "nominal", "bandpass");
    expect(gated.gateShape).toBe("normal");
  });

  test("invalid gate span is rejected with warning", () => {
    const spData = buildSyntheticSparam(1e9, 2e9, 64, () => ({ magnitude: 0.2, angle: 0 }));
    const td = frequencyToTimeDomain(spData, "bandpass", "rectangular");
    const gated = applyGate(td, 1e-9, 1.1e-9, "maximum", "bandpass");
    expect(gated.valid).toBe(false);
    expect(gated.warning).toMatch(/minimum/i);
  });

  test("bandpass gate isolates a selected delayed reflection", () => {
    const fStart = 1e9;
    const fStop = 11e9;
    const points = 201;
    const t1 = 0.7e-9;
    const t2 = 2.0e-9;
    const spData = buildTwoReflectionSParam(fStart, fStop, points, 0.7, t1, 0.35, t2);
    const td = frequencyToTimeDomain(spData, "bandpass", "rectangular");

    const gated = applyGate(td, t1 - 0.4e-9, t1 + 0.4e-9, "minimum", "bandpass");
    expect(gated.valid).toBe(true);
    const gatedS = gatedToSParamFormat(gated, spData);
    const tdG = frequencyToTimeDomain(gatedS, "bandpass", "rectangular");

    const i1 = nearestIndex(tdG.timeAxis, t1);
    const i2 = nearestIndex(tdG.timeAxis, t2);
    expect(tdG.magnitude[i1]).toBeGreaterThan(tdG.magnitude[i2] * 1.8);
  });

  test("notch gate removes a selected delayed reflection", () => {
    const fStart = 1e9;
    const fStop = 11e9;
    const points = 201;
    const t1 = 0.7e-9;
    const t2 = 2.0e-9;
    const spData = buildTwoReflectionSParam(fStart, fStop, points, 0.7, t1, 0.35, t2);
    const td = frequencyToTimeDomain(spData, "bandpass", "rectangular");

    const gated = applyGate(td, t1 - 0.4e-9, t1 + 0.4e-9, "minimum", "notch");
    expect(gated.valid).toBe(true);
    const gatedS = gatedToSParamFormat(gated, spData);
    const tdG = frequencyToTimeDomain(gatedS, "bandpass", "rectangular");

    const i1 = nearestIndex(tdG.timeAxis, t1);
    const i2 = nearestIndex(tdG.timeAxis, t2);
    expect(tdG.magnitude[i1]).toBeLessThan(tdG.magnitude[i2]);
  });
});
