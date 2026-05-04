import { Grid, Typography, Box } from "@mui/material";
import Tooltip from "@mui/material/Tooltip";
import "uplot/dist/uPlot.min.css";
import UplotReact from "uplot-react";
import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";

import { processImpedance, rectangularToPolar, polarToRectangular, unitConverter } from "./commonFunctions";
import { VNA_STAGES } from "./vnaStages.js";

function ImpedanceRes({ type, zStr, zPolarStr }) {
  return (
    <>
      <Box
        sx={{
          border: "1px solid #ccc",
          borderRadius: 1,
          padding: 1,
          width: "155px",
          backgroundColor: "rgb(37, 50, 64)",
          color: "white",
        }}
      >
        <Typography variant="body1">{type}</Typography>
      </Box>
      <Box
        sx={{
          border: "1px solid #ccc",
          borderRadius: 1,
          padding: 1,
          flex: 1,
        }}
      >
        <Typography variant="body1">{zStr}</Typography>
      </Box>
      <Box
        sx={{
          border: "1px solid #ccc",
          borderRadius: 1,
          padding: 1,
          flex: 1,
        }}
      >
        <Typography variant="body1">{zPolarStr}</Typography>
      </Box>
    </>
  );
}

function MiniRes({ type, res }) {
  return (
    <>
      <Box
        sx={{
          border: "1px solid #ccc",
          borderRadius: 1,
          padding: 1,
          width: "65px",
          backgroundColor: "rgb(37, 50, 64)",
          color: "white",
        }}
      >
        <Typography variant="body1">{type}</Typography>
      </Box>
      <Box
        sx={{
          border: "1px solid #ccc",
          borderRadius: 1,
          padding: 1,
          mr: 0.5,
          flex: 1,
        }}
      >
        <Typography variant="body1">{res}</Typography>
      </Box>
    </>
  );
}

const commonOptionsInit = {
  width: 500,
  height: 300,
  series: [
    { label: "Frequency (unit undefined)" }, // x
  ],
  axes: [
    { label: "Frequency (unit undefined)" }, // x
  ],
};

const optionsInit = {
  height: 300,
  series: [
    {
      label: "|S11| (dB)",
      stroke: "blue",
      width: 2,
      scale: "y",
    },
    {
      label: "∠S11 (°)",
      stroke: "red",
      width: 2,
      scale: "y2", // assign to second y axis
    },
  ],
  axes: [
    {
      // left y-axis
      scale: "y",
      label: "|S11| (dB)",
    },
    {
      // right y-axis
      scale: "y2",
      side: 1, // right side
      label: "∠S11 (°)",
    },
  ],
  scales: {
    x: { time: false },
    y: { auto: true },
    y2: { auto: true }, // independent scale for right axis
  },
};

const options2Init = {
  series: [
    {
      label: "|S21| (dB)",
      stroke: "green",
      width: 2,
      scale: "y",
    },
  ],
  axes: [
    {
      // left y-axis
      scale: "y",
      label: "|S21| (dB)",
    },
  ],
  scales: {
    x: { time: false },
    y: { auto: true },
  },
};

const optionsGainInit = {
  series: [],
  axes: [
    {
      // left y-axis
      scale: "y",
      label: "gain (dB)",
    },
  ],
  scales: {
    x: { time: false },
    y: { auto: true },
  },
};

// function renderChart(setOptions, setOptions2, containerRef, freqUnit) {
//   setOptions((o) => {
//     return {
//       ...o,
//       width: containerRef.current.offsetWidth,
//       series: o.series.map((s, i) => {
//         if (i === 0) return { ...s, label: `Frequency (${freqUnit})` };
//         return s;
//       }),
//       axes: o.axes.map((a, i) => {
//         if (i === 0) return { ...a, label: `Frequency (${freqUnit})` };
//         return a;
//       }),
//     };
//   });
//   setOptions2((o) => {
//     return {
//       ...o,
//       width: containerRef.current.offsetWidth,
//       series: o.series.map((s, i) => {
//         if (i === 0) return { ...s, label: `Frequency (${freqUnit})` };
//         return s;
//       }),
//       axes: o.axes.map((a, i) => {
//         if (i === 0) return { ...a, label: `Frequency (${freqUnit})` };
//         return a;
//       }),
//     };
//   });
// }

function renderChart_new(setCommon, containerRef, freqUnit, t) {
  const freqLabel = t("results.frequencyAxis", { unit: freqUnit });
  setCommon((o) => {
    return {
      ...o,
      width: containerRef.current.offsetWidth,
      series: o.series.map((s, i) => {
        if (i === 0) return { ...s, label: freqLabel };
        return s;
      }),
      axes: o.axes.map((a, i) => {
        if (i === 0) return { ...a, label: freqLabel };
        return a;
      }),
    };
  });
}

function localizedOptionsInit(t) {
  return {
    ...optionsInit,
    series: [
      { ...optionsInit.series[0], label: t("results.s11db") },
      { ...optionsInit.series[1], label: t("results.s11ang") },
    ],
    axes: [
      { ...optionsInit.axes[0], label: t("results.s11db") },
      { ...optionsInit.axes[1], label: t("results.s11ang") },
    ],
  };
}

function localizedOptions2Init(t) {
  return {
    ...options2Init,
    series: [{ ...options2Init.series[0], label: t("results.s21db") }],
    axes: [{ ...options2Init.axes[0], label: t("results.s21db") }],
  };
}

function localizedOptionsZInit(t) {
  return {
    axes: [
      { scale: "y", label: t("results.zMag") },
      { scale: "y2", side: 1, label: t("results.zAng") },
    ],
  };
}

function localizedOptionsGainInit(t) {
  return {
    ...optionsGainInit,
    axes: [{ ...optionsGainInit.axes[0], label: t("results.gainAxis") }],
  };
}

// ---------------------------------------------------------------------------
// Helper: convert a frequency-keyed S11 polar dataset to |S11|_dB and |Z| arrays
// ---------------------------------------------------------------------------
function sparamToTraceArrays(sparamData, freqUnit, zo) {
  const sortedFreqs = Object.keys(sparamData).sort((a, b) => a - b);
  const fAxis = sortedFreqs.map((fx) => fx / unitConverter[freqUnit]);
  const s11dBArr = [];
  const zMagArr = [];
  for (const fx of sortedFreqs) {
    const entry = sparamData[fx];
    if (!entry || !entry.S11) {
      s11dBArr.push(null);
      zMagArr.push(null);
      continue;
    }
    const { magnitude, angle } = entry.S11;
    s11dBArr.push(20 * Math.log10(Math.max(magnitude, 1e-15)));
    // |Z| = |Zo * (1 + Γ) / (1 - Γ)|
    const rect = polarToRectangular({ magnitude, angle });
    const num = { real: 1 + rect.real, imaginary: rect.imaginary };
    const den = { real: 1 - rect.real, imaginary: -rect.imaginary };
    const denMag2 = den.real * den.real + den.imaginary * den.imaginary;
    const zRe = zo * (num.real * den.real + num.imaginary * den.imaginary) / Math.max(denMag2, 1e-30);
    const zIm = zo * (num.imaginary * den.real - num.real * den.imaginary) / Math.max(denMag2, 1e-30);
    zMagArr.push(Math.sqrt(zRe * zRe + zIm * zIm));
  }
  return { fAxis, s11dBArr, zMagArr };
}

// ---------------------------------------------------------------------------
// Intermediate-stage overlay charts for |S11| (dB) and |Z| (Ω)
// ---------------------------------------------------------------------------
function IntermediateTracesPlots({ intermediateTraces, activeStages, sParamZo, freqUnit, commonOptions }) {
  const { t } = useTranslation();
  if (!intermediateTraces || !activeStages) return null;

  // Determine which stages have data and are active
  const stagesWithData = VNA_STAGES.filter(({ key }) => {
    const data = intermediateTraces[key];
    if (!data || typeof data !== "object") return false;
    if (Object.keys(data).length === 0) return false;
    // "afterGating" in intermediateTraces is the raw applyGate output ({gatedFdMag, freqAxis, ...}),
    // NOT the standard S-param format — skip it here (the Smith chart handles it separately).
    if ("gatedFdMag" in data) return false;
    if (key === "raw") return true;
    if (key === "afterCal") return activeStages.cal;
    if (key === "afterDeembed") return activeStages.deembed;
    if (key === "afterPe") return activeStages.pe;
    if (key === "afterGating") return activeStages.gating;
    return false;
  });

  if (stagesWithData.length === 0) return null;

  const width = commonOptions?.width ?? 500;
  const height = 220;

  // Build |S11| dB chart data
  const s11Series = [{ label: `Freq (${freqUnit})` }];
  const s11Data = [null]; // placeholder for fAxis (filled from first stage)
  let fAxis = null;
  for (const stage of stagesWithData) {
    const { fAxis: fa, s11dBArr } = sparamToTraceArrays(intermediateTraces[stage.key], freqUnit, sParamZo);
    if (!fAxis) {
      fAxis = fa;
      s11Data[0] = fAxis;
    }
    s11Data.push(s11dBArr);
    s11Series.push({
      label: t(stage.labelKey),
      stroke: stage.color,
      width: stage.widthPx ?? 1.5,
      dash: stage.dash ? stage.dash.split(",").map(Number) : undefined,
      scale: "y",
    });
  }

  if (!fAxis || fAxis.length === 0) return null;

  // Build |Z| magnitude chart data
  const zSeries = [{ label: `Freq (${freqUnit})` }];
  const zData = [fAxis];
  for (const stage of stagesWithData) {
    const { zMagArr } = sparamToTraceArrays(intermediateTraces[stage.key], freqUnit, sParamZo);
    zData.push(zMagArr);
    zSeries.push({
      label: t(stage.labelKey),
      stroke: stage.color,
      width: stage.widthPx ?? 1.5,
      dash: stage.dash ? stage.dash.split(",").map(Number) : undefined,
      scale: "y",
    });
  }

  const s11Opt = {
    width,
    height,
    series: s11Series,
    axes: [{ label: `Freq (${freqUnit})` }, { scale: "y", label: "|S11| (dB)" }],
    scales: { x: { time: false }, y: { auto: true } },
  };

  const zOpt = {
    width,
    height,
    series: zSeries,
    axes: [{ label: `Freq (${freqUnit})` }, { scale: "y", label: "|Z| (Ω)" }],
    scales: { x: { time: false }, y: { auto: true } },
  };

  return (
    <Box sx={{ mt: 2 }}>
      <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
        {t("results.correctionStages")}
      </Typography>
      <UplotReact options={s11Opt} data={s11Data} />
      <UplotReact options={zOpt} data={zData} />
    </Box>
  );
}

function SPlot({ sparametersData, options, freqUnit, title }) {
  const { t } = useTranslation();
  if (!sparametersData || sparametersData.length === 0) return null;
  return ["S11", "S12", "S21", "S22"].map((s) => {
    if (!(s in Object.values(sparametersData)[0])) return null;
    const sParamOpt = JSON.parse(JSON.stringify(options));
    sParamOpt.series[1].label = `| ${s} | (dB)`;
    sParamOpt.series[2].label = `∠ ${s} |(°)`;
    sParamOpt.axes[1].label = `| ${s} | (dB)`;
    sParamOpt.axes[2].label = `∠ ${s} |(°)`;
    const f = [];
    const m = [];
    const a = [];
    for (const fx in sparametersData) {
      f.push(fx / unitConverter[freqUnit]);
      m.push(20 * Math.log10(sparametersData[fx][s].magnitude));
      a.push(sparametersData[fx][s].angle);
    }
    const sData = [f, m, a];
    return (
      <div style={{ textAlign: "center" }} key={s}>
        <h5 style={{ marginTop: 15, marginBottom: 0 }}>
          {title}: {t("results.sMagPhase", { s })}
        </h5>
        <UplotReact options={sParamOpt} data={sData} />
      </div>
    );
  });
}
/** plotKind "z": |Z| (Ω) + ∠Z (°) from rectangularToPolar(z); "s11": |Γ| dB + phase via processImpedance; "s21": |S21| dB (|S11|²+|S21|²=1). */
function SpanTolerancePlot({ spanResultsByTol, options, freqUnit, zo, plotKind, legendY }) {
  const { t } = useTranslation();
  const dualY = plotKind === "s11" || plotKind === "z";
  if (!spanResultsByTol || spanResultsByTol.length === 0) return null;
  const nominal = spanResultsByTol[spanResultsByTol.length - 1];
  if (!nominal || Object.keys(nominal).length === 0) return null;
  const sParamOpt = JSON.parse(JSON.stringify(options));
  if (!dualY) {
    sParamOpt.axes[1].label = legendY;
  }
  const sortedFreq = Object.keys(nominal).sort((a, b) => a - b);
  const fAxis = sortedFreq.map((fx) => fx / unitConverter[freqUnit]);
  const seriesData = [];
  for (let i = 0; i < spanResultsByTol.length; i++) {
    const tolMap = spanResultsByTol[i];
    const magVals = [];
    const angVals = [];
    for (const fx of sortedFreq) {
      if (plotKind === "z") {
        const { magnitude, angle } = rectangularToPolar(tolMap[fx].z);
        magVals.push(magnitude);
        angVals.push(angle);
      } else if (plotKind === "s11") {
        const { refReal, refImag } = processImpedance(tolMap[fx].z, zo);
        const { magnitude, angle } = rectangularToPolar({ real: refReal, imaginary: refImag });
        magVals.push(20 * Math.log10(magnitude));
        angVals.push(angle);
      } else {
        const { refReal, refImag } = processImpedance(tolMap[fx].z, zo);
        const { magnitude } = rectangularToPolar({ real: refReal, imaginary: refImag });
        magVals.push(20 * Math.log10(Math.sqrt(1 - magnitude ** 2)));
      }
    }
    const last = i === spanResultsByTol.length - 1;
    if (dualY) {
      seriesData.push(magVals, angVals);
      if (plotKind === "s11") {
        sParamOpt.series.push(
          {
            label: last ? t("results.s11db") : t("results.tolPipe", { i }),
            stroke: last ? "blue" : "#4b4c80",
            width: 2,
            scale: "y",
          },
          {
            label: last ? t("results.s11ang") : t("results.tolAng", { i }),
            stroke: last ? "red" : "#9c5656",
            width: 2,
            scale: "y2",
          },
        );
      } else {
        sParamOpt.series.push(
          {
            label: last ? t("results.zMag") : t("results.zTolMag", { i }),
            stroke: last ? "blue" : "#4b4c80",
            width: 2,
            scale: "y",
          },
          {
            label: last ? t("results.zAng") : t("results.zTolAng", { i }),
            stroke: last ? "red" : "#9c5656",
            width: 2,
            scale: "y2",
          },
        );
      }
    } else {
      seriesData.push(magVals);
      sParamOpt.series.push({
        label: last ? legendY : t("results.tol", { i }),
        stroke: last ? "green" : "gray",
        width: 2,
        scale: "y",
      });
    }
  }
  const gData = [fAxis, ...seriesData];
  return <UplotReact options={sParamOpt} data={gData} />;
}
function GainPlot({ gain, options, freqUnit, title, legend }) {
  const { t } = useTranslation();
  if (!gain || Object.keys(gain).length === 0) return null;
  const sParamOpt = JSON.parse(JSON.stringify(options));
  sParamOpt.axes[1].label = legend;
  const sData = [];
  for (const i in gain) {
    const m = [];
    for (const v in gain[i]) {
      m.push(10 * Math.log10(gain[i][v]));
    }
    sData.push(m);
    sParamOpt.series.push({
      label: i == gain.length - 1 ? legend : t("results.tol", { i }),
      stroke: i == gain.length - 1 ? "blue" : "gray",
      width: 2,
      scale: "y",
    });
  }
  const f = Object.keys(gain[0]).map((x) => x / unitConverter[freqUnit]);
  const gData = [f, ...sData];
  return (
    <div style={{ textAlign: "center" }}>
      <h5 style={{ marginTop: 15, marginBottom: 0 }}>{title}</h5>
      <UplotReact options={sParamOpt} data={gData} />
    </div>
  );
}
function RPlot({ RefIn, options, freqUnit, title }) {
  const { t } = useTranslation();
  if (!RefIn || Object.keys(RefIn).length === 0) return null;
  const sParamOpt = JSON.parse(JSON.stringify(options));
  // const f = [];
  const plotData = [Object.keys(RefIn[0]).map((x) => x / unitConverter[freqUnit])];
  for (const i in RefIn) {
    const m = [];
    const a = [];
    for (const v in RefIn[i]) {
      m.push(20 * Math.log10(RefIn[i][v].magnitude));
      a.push(RefIn[i][v].angle);
    }
    plotData.push(m, a);
    sParamOpt.series.push(
      {
        label: i == RefIn.length - 1 ? t("results.s11db") : t("results.tolPipe", { i }),
        stroke: i == RefIn.length - 1 ? "blue" : "#4b4c80",
        width: 2,
        scale: "y",
      },
      {
        label: i == RefIn.length - 1 ? t("results.s11ang") : t("results.tolAng", { i }),
        stroke: i == RefIn.length - 1 ? "red" : "#9c5656",
        width: 2,
        scale: "y2",
      },
    );
  }
  return (
    <div style={{ textAlign: "center" }}>
      <h5 style={{ marginTop: 15, marginBottom: 0 }}>{title}</h5>
      <UplotReact options={sParamOpt} data={plotData} />
    </div>
  );
}

/**
 * UncertaintyPlot: renders ±uncertainty bands as shaded areas on an S11 magnitude plot.
 * Uses a canvas overlay approach through uPlot's hooks.
 */
function UncertaintyPlot({ uncertaintyBands, options, freqUnit }) {
  const { t } = useTranslation();
  if (!uncertaintyBands || !uncertaintyBands.freqs || uncertaintyBands.freqs.length === 0) return null;

  const { freqs, s11_mag_dB, upper_dB, lower_dB, maxUncertainty_dB, maxUncertainty_f, dominantSource } = uncertaintyBands;
  const fAxis = freqs.map((f) => f / unitConverter[freqUnit]);

  const opt = JSON.parse(JSON.stringify(options));
  // Nominal S11 series
  opt.series.push({ label: "|S11| (dB)", stroke: "blue", width: 2, scale: "y" });
  // Upper bound
  opt.series.push({ label: "+unc (dB)", stroke: "rgba(255,80,0,0.7)", width: 1, scale: "y", dash: [4, 3] });
  // Lower bound
  opt.series.push({ label: "−unc (dB)", stroke: "rgba(255,80,0,0.7)", width: 1, scale: "y", fill: "rgba(255,80,0,0.15)", dash: [4, 3] });

  const data = [fAxis, s11_mag_dB, upper_dB, lower_dB];

  return (
    <Box sx={{ mt: 2 }}>
      <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
        {t("vna.unc.plotTitle")}
      </Typography>
      <UplotReact options={opt} data={data} />
      <Typography variant="caption" color="text.secondary">
        {t("vna.unc.maxUnc", {
          v: maxUncertainty_dB.toFixed(2),
          f: (maxUncertainty_f / unitConverter[freqUnit]).toPrecision(4),
          unit: freqUnit,
          src: dominantSource,
        })}
      </Typography>
    </Box>
  );
}

export default function Results({ zProc, spanResults, freqUnit, plotType, sParameters, gainResults, noiseArray, RefIn, zo, uncertaintyBands, intermediateTraces, activeStages, sParamZo }) {
  const { t, i18n } = useTranslation();
  const { zStr, zPolarStr, refStr, refPolarStr, vswr, qFactor } = zProc;
  const containerRef = useRef();
  // const [options, setOptions] = useState(optionsInit);
  // const [options2, setOptions2] = useState(options2Init);
  const [commonOptions, setCommonOptions] = useState(commonOptionsInit);

  const loc1 = localizedOptionsInit(t);
  const loc2 = localizedOptions2Init(t);
  const locZ = localizedOptionsZInit(t);
  const locG = localizedOptionsGainInit(t);

  const optionsS21 = {
    width: commonOptions.width,
    height: commonOptions.height,
    series: [...commonOptions.series],
    axes: [...commonOptions.axes, ...loc2.axes],
    scales: options2Init.scales,
  };

  const optionsS11Tol = {
    width: commonOptions.width,
    height: commonOptions.height,
    series: [...commonOptions.series],
    axes: [...commonOptions.axes, ...loc1.axes],
    scales: optionsInit.scales,
  };

  const optionsZTol = {
    width: commonOptions.width,
    height: commonOptions.height,
    series: [...commonOptions.series],
    axes: [...commonOptions.axes, ...locZ.axes],
    scales: optionsInit.scales,
  };

  const options4 = {
    width: commonOptions.width,
    height: commonOptions.height,
    series: [...commonOptions.series, ...loc1.series],
    axes: [...commonOptions.axes, ...loc1.axes],
    scales: optionsInit.scales,
  };

  const optionsGain = {
    width: commonOptions.width,
    height: commonOptions.height,
    series: [...commonOptions.series, ...optionsGainInit.series],
    axes: [...commonOptions.axes, ...locG.axes],
    scales: optionsGainInit.scales,
  };

  const optionsS11 = {
    width: commonOptions.width,
    height: commonOptions.height,
    series: commonOptions.series,
    axes: [...commonOptions.axes, ...loc1.axes],
    scales: optionsInit.scales,
  };

  var s21 = [];
  //FIXME - move this to a separate function so we can do unit testing
  const nominalSpan = spanResults[spanResults.length - 1];
  const sortedSpanFrequencies = Object.keys(nominalSpan).sort((a, b) => a - b);
  for (const f of sortedSpanFrequencies) {
    const { refReal, refImag } = processImpedance(nominalSpan[f].z, zo);
    const { magnitude } = rectangularToPolar({
      real: refReal,
      imaginary: refImag,
    });
    s21.push(20 * Math.log10(Math.sqrt(1 - magnitude ** 2)));
  }
  const absSpanFrequencies = sortedSpanFrequencies.map((f) => f / unitConverter[freqUnit]);

  var maxS21 = s21[0];
  var maxF = 0;
  var db3_l = -1;
  var db3_m = -1;
  var i, maxIndex;
  for (i = 0; i < absSpanFrequencies.length; i++) {
    if (s21[i] > maxS21) {
      maxIndex = i;
      maxS21 = s21[i];
      maxF = absSpanFrequencies[i];
    }
  }
  for (i = maxIndex; i >= 0; i--) {
    if (s21[i] < maxS21 - 3) {
      db3_l = absSpanFrequencies[i];
      break;
    }
  }
  for (i = maxIndex; i < absSpanFrequencies.length; i++) {
    if (s21[i] < maxS21 - 3) {
      db3_m = absSpanFrequencies[i];
      break;
    }
  }

  useEffect(() => {
    function handleResize() {
      renderChart_new(setCommonOptions, containerRef, freqUnit, t);
    }
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, [freqUnit, t, i18n.language]);

  // plot s-parameters straight from the file
  if (plotType === "sparam" && sParameters !== null) {
    const sparametersData = sParameters.data;
    return (
      <div ref={containerRef} style={{ width: "100%", marginTop: "30px" }}>
        <SPlot sparametersData={sparametersData} options={options4} freqUnit={freqUnit} title={t("results.rawData")} />
        <UncertaintyPlot uncertaintyBands={uncertaintyBands} options={optionsS11} freqUnit={freqUnit} />
        <IntermediateTracesPlots
          intermediateTraces={intermediateTraces}
          activeStages={activeStages}
          sParamZo={sParamZo ?? zo}
          freqUnit={freqUnit}
          commonOptions={commonOptions}
        />
      </div>
    );

    // plot s-parameters when terminated with custom impedance
  } else if (plotType !== "sparam" && sParameters !== null) {
    return (
      <div ref={containerRef} style={{ width: "100%", marginTop: "30px" }}>
        <RPlot RefIn={RefIn} options={optionsS11} freqUnit={freqUnit} title={t("results.zDp1")} />
        <UncertaintyPlot uncertaintyBands={uncertaintyBands} options={optionsS11} freqUnit={freqUnit} />
        <IntermediateTracesPlots
          intermediateTraces={intermediateTraces}
          activeStages={activeStages}
          sParamZo={sParamZo ?? zo}
          freqUnit={freqUnit}
          commonOptions={commonOptions}
        />
        <GainPlot gain={gainResults} options={optionsGain} freqUnit={freqUnit} title={t("results.systemGain")} legend={t("results.gainLegend")} />
        <GainPlot gain={noiseArray} options={optionsGain} freqUnit={freqUnit} title={t("results.noiseFigure")} legend={t("results.nfLegend")} />
      </div>
    );
  } else
    return (
      <>
        <Typography variant="h5" sx={{ textAlign: "center", mb: 2 }}>
          {t("results.finalResults")}
        </Typography>
        <Grid container spacing={1}>
          <Grid size={{ xs: 12, sm: 12, md: 12, lg: 9 }} sx={{ display: "flex" }}>
            <ImpedanceRes type={t("results.impedanceOhm")} zStr={zStr} zPolarStr={zPolarStr} />
          </Grid>
          <Tooltip title={t("results.vswrTooltip")} arrow placement="top">
            <Grid size={{ xs: 12, sm: 12, md: 12, lg: 3 }} sx={{ display: "flex" }}>
              <MiniRes type="VSWR" res={vswr} />
            </Grid>
          </Tooltip>
          <Grid size={{ xs: 12, sm: 12, md: 12, lg: 9 }} sx={{ display: "flex" }}>
            <ImpedanceRes type={t("results.reflectionCoeff")} zStr={refStr} zPolarStr={refPolarStr} />
          </Grid>
          <Grid size={{ xs: 12, sm: 12, md: 12, lg: 3 }} sx={{ display: "flex" }}>
            <MiniRes type={t("results.qFactor")} res={qFactor} />
          </Grid>
        </Grid>

        <div ref={containerRef} style={{ width: "100%", marginTop: "30px" }}>
          <SpanTolerancePlot spanResultsByTol={spanResults} options={optionsZTol} freqUnit={freqUnit} zo={zo} plotKind="z" />
          <SpanTolerancePlot spanResultsByTol={spanResults} options={optionsS11Tol} freqUnit={freqUnit} zo={zo} plotKind="s11" />
          <UncertaintyPlot uncertaintyBands={uncertaintyBands} options={optionsS11} freqUnit={freqUnit} />
          <Typography sx={{ textAlign: "center", mt: 2 }}>
            {t("results.assuming")}{" "}
            <i>
              S<sub>11</sub>
              <sup>2</sup> + S<sub>21</sub>
              <sup>2</sup> = 1
            </i>
            )
          </Typography>
          <SpanTolerancePlot
            spanResultsByTol={spanResults}
            options={optionsS21}
            freqUnit={freqUnit}
            zo={zo}
            plotKind="s21"
            legendY={t("results.s21db")}
          />
        </div>
        <ul>
          <li>{t("results.maxS21", { v: maxS21.toPrecision(6), f: maxF, unit: freqUnit })}</li>
          <li>
            {t("results.bw3db", {
              v: db3_l == -1 || db3_m == -1 ? t("results.na") : (db3_m - db3_l).toPrecision(6),
              unit: freqUnit,
            })}
          </li>
        </ul>
      </>
    );
}
