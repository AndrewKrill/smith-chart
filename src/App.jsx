/* global gtag */
import { useState, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Link from "@mui/material/Link";

import Grid from "@mui/material/Grid";
import Card from "@mui/material/Card";
import Snackbar from "@mui/material/Snackbar";
import SnackbarContent from "@mui/material/SnackbarContent";
import CardContent from "@mui/material/CardContent";
import { ThemeProvider } from "@mui/material/styles";
import NavBar from "./NavBar.jsx";
import Footer from "./Footer.jsx";
import Circuit from "./Circuit.jsx";
import Graph from "./Graph.jsx";
import Results from "./Results.jsx";
import Settings from "./Settings.jsx";
import Equations from "./Equations.jsx";
import ReleaseNotes from "./ReleaseNotes.jsx";
import Tutorials from "./Tutorials.jsx";
import { Comments } from "@hyvor/hyvor-talk-react";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";

import { syncObjectToUrl, updateObjectFromUrl } from "./urlFunctions.js"; // Import the syncObjectToUrl function
import { theme, convertSettingsToFloat, unitConverter, polarToRectangular, rectangularToPolar } from "./commonFunctions.js";
import { circuitComponents } from "./circuitComponents.js";

import { allImpedanceCalculations, synthesizeS11FromCircuit } from "./impedanceFunctions.js";
// import { sParamFrequencyRange } from "./sparam.js"; // Import the sParamFrequencyRange function

import {
  applyCalibrationToDataset,
  computeErrorTerms,
  applyCalibration,
  idealStandards,
  realisticOpenGamma,
  realisticShortGamma,
  realisticLoadGamma,
} from "./calibration.js";
import { applyPortExtension } from "./portExtension.js";
import { applyDeembedding } from "./deembedding.js";
import { frequencyToTimeDomain, applyGate, computeTdrResolution } from "./tdr.js";
import { computeUncertaintyBands } from "./uncertainty.js";
import VnaTools from "./VnaTools.jsx";
import VnaSmithChart from "./VnaSmithChart.jsx";

import debounce from "lodash/debounce";

const initialState = {
  zo: 50,
  frequency: 2440,
  frequencyUnit: "MHz",
  fSpan: 0,
  fSpanUnit: "MHz",
  fRes: 10,
  zMarkers: [],
  vswrCircles: [],
  qCircles: [],
  nfCircles: [],
  gainInCircles: [],
  gainOutCircles: [],
};

const initialCalSettings = {
  enabled: false,
  calType: "OSL",
  useIdeal: true,
  standards: {},
  planeDP: null,
};

const initialPeSettings = {
  enabled: false,
  length: 0,
  unit: "mm",
  zo: 50,
  eeff: 1,
};

const initialDeembedSettings = {
  enabled: false,
  mode: "deembed",
  fixtureType: "tline",
  fixtureLength: 0,
  fixtureLengthUnit: "mm",
  fixtureZo: 50,
  fixtureEeff: 1,
};

const initialTdrSettings = {
  enabled: false,
  mode: "bandpass",
  window: "rectangular",
  gateEnabled: false,
  gateStart: 0,
  gateStop: 1e-9,
  gateShape: "nominal",
  velocityFactor: 1,
  synthPoints: 201,
  synthFmin: null,
  synthFmax: null,
};

const initialUncertaintySettings = {
  enabled: false,
  noiseFloor_dB: -60,
  repeatability_dB: -50,
  pathAttenuation_dB: 0,
  useIdeal: true,
  realisticParams: {},
};

const initialCircuit = [{ name: "blackBox", ...circuitComponents.blackBox.default }];

const params = new URLSearchParams(window.location.search);
var [stateInURL, defaultCircuit, urlContainsState] = updateObjectFromUrl(initialState, initialCircuit, params);
console.log("stateInURL", stateInURL, defaultCircuit, urlContainsState);

function App() {
  const { t, i18n } = useTranslation();
  const [userCircuit, setUserCircuit] = useState(defaultCircuit);
  const [settings, setSettings] = useState(stateInURL);
  const [urlSnackbar, setUrlSnackbar] = useState(false);
  const [plotType, setPlotType] = useState("impedance");
  const [showIdeal, setShowIdeal] = useState(false);

  // VNA tool states
  const [calSettings, setCalSettings] = useState(initialCalSettings);
  const [peSettings, setPeSettings] = useState(initialPeSettings);
  const [deembedSettings, setDeembedSettings] = useState(initialDeembedSettings);
  const [tdrSettings, setTdrSettings] = useState(initialTdrSettings);
  const [uncertaintySettings, setUncertaintySettings] = useState(initialUncertaintySettings);

  // Split-chart mode: processed data on its own second Smith chart
  const [splitSmithChart, setSplitSmithChart] = useState(false);
  // Which intermediate pipeline stages to display on the second Smith chart
  const [visibleStages, setVisibleStages] = useState({
    raw: true,
    afterCal: true,
    afterDeembed: true,
    afterPe: true,
    afterGating: true,
  });

  const settingsFloat = convertSettingsToFloat(JSON.parse(JSON.stringify(settings)));

  //debounding the URL syncing because 100 updateHistory in 10s causes chrome to crash, which happens when using sliders
  const debouncedSync = useMemo(() => debounce(syncObjectToUrl, 1000), []);
  // Run when dependencies change
  useEffect(() => {
    debouncedSync(settings, initialState, userCircuit, initialCircuit);
  }, [settings, userCircuit, debouncedSync]);

  // ---------------------------------------------------------------------------
  // VNA correction pipeline — staged memos (order: Cal → Deembed → PE → Gating)
  // ---------------------------------------------------------------------------

  // Raw S-param data as loaded from file, before any corrections
  const rawSParamData = useMemo(() => {
    const idx = userCircuit.findIndex((c) => c.name === "sparam");
    return idx === -1 ? null : userCircuit[idx].data;
  }, [userCircuit]);

  // Step 1: Calibration
  const afterCalData = useMemo(() => {
    if (!rawSParamData || !calSettings.enabled) return rawSParamData;
    return applyCalibrationToDataset(rawSParamData, calSettings, settingsFloat.zo);
  }, [rawSParamData, calSettings, settingsFloat.zo]);

  // Step 2: De-embedding (before port extension; supports S1P and S2P)
  const afterDeembedData = useMemo(() => {
    if (!afterCalData || !deembedSettings.enabled) return afterCalData;
    const fixLenM = parseFloat(deembedSettings.fixtureLength) * (unitConverter[deembedSettings.fixtureLengthUnit] || 1e-3);
    return applyDeembedding(afterCalData, { ...deembedSettings, fixtureLength: fixLenM });
  }, [afterCalData, deembedSettings]);

  // Step 3: Port extension (after de-embedding)
  const afterPeData = useMemo(() => {
    if (!afterDeembedData || !peSettings.enabled) return afterDeembedData;
    const lenM = parseFloat(peSettings.length) * (unitConverter[peSettings.unit] || 1e-3);
    if (!lenM) return afterDeembedData;
    return applyPortExtension(afterDeembedData, lenM, parseFloat(peSettings.eeff) || 1);
  }, [afterDeembedData, peSettings]);

  // Build a corrected userCircuit from the final processed data
  const correctedUserCircuit = useMemo(() => {
    const sParamIdx = userCircuit.findIndex((c) => c.name === "sparam");
    if (sParamIdx === -1 || !afterPeData || afterPeData === rawSParamData) return userCircuit;
    const newCircuit = [...userCircuit];
    newCircuit[sParamIdx] = { ...userCircuit[sParamIdx], data: afterPeData };
    return newCircuit;
  }, [userCircuit, afterPeData, rawSParamData]);

  const [processedImpedanceResults, spanResults, multiZResults, gainArray, noiseArray, numericalFrequency, RefIn, noiseFrequency] =
    allImpedanceCalculations(correctedUserCircuit, settingsFloat, showIdeal);

  //check if esr or esl exists, and if it does exist check that it is not 0 or ''
  const nonIdealUsed = userCircuit.findIndex((c) => (c.esr != null && c.esr != 0 && c.esr !== "") || (c.esl != null && c.esl != 0 && c.esl !== ""));

  const sParamIndex = userCircuit.findIndex((c) => c.name === "sparam");
  const correctedSParamIndex = correctedUserCircuit.findIndex((c) => c.name === "sparam");
  const sParameters = sParamIndex === -1 ? null : correctedUserCircuit[correctedSParamIndex];
  const s1pIndex = userCircuit.findIndex((c) => c.type === "s1p");
  const chosenSparameter =
    sParamIndex === -1
      ? null
      : { ...correctedUserCircuit[correctedSParamIndex].data[numericalFrequency], zo: correctedUserCircuit[correctedSParamIndex].settings.zo };
  const chosenNoiseParameter = noiseFrequency === -1 ? null : userCircuit[sParamIndex].noise[noiseFrequency];

  // Synthesize S11 from the component circuit when no S-param file is loaded
  const synthesizedSParamData = useMemo(() => {
    const sParamIdx = userCircuit.findIndex((c) => c.name === "sparam");
    if (sParamIdx !== -1) return null; // file loaded — no synthesis needed

    const sf = convertSettingsToFloat(JSON.parse(JSON.stringify(settings)));
    const centerF = sf.frequency * unitConverter[settings.frequencyUnit];
    const fSpanHz = sf.fSpan * unitConverter[settings.fSpanUnit];
    const nPoints = tdrSettings.synthPoints || 201;

    let fMin, fMax;
    if (tdrSettings.synthFmin !== null && tdrSettings.synthFmax !== null) {
      fMin = tdrSettings.synthFmin;
      fMax = tdrSettings.synthFmax;
    } else if (fSpanHz > 0) {
      fMin = Math.max(centerF - fSpanHz, 1);
      fMax = centerF + fSpanHz;
    } else {
      // Default: ±50 % of centre frequency
      fMin = centerF * 0.5;
      fMax = centerF * 1.5;
    }

    const frequencies = [];
    for (let i = 0; i < nPoints; i++) {
      frequencies.push(fMin + (i * (fMax - fMin)) / (nPoints - 1));
    }
    return synthesizeS11FromCircuit(userCircuit, frequencies, sf.zo);
  }, [userCircuit, settings, tdrSettings.synthPoints, tdrSettings.synthFmin, tdrSettings.synthFmax]);

  // Port-extension applied to synthesized data (only when no S-param file)
  const peAppliedSynData = useMemo(() => {
    if (!synthesizedSParamData || !peSettings.enabled) return synthesizedSParamData;
    const lenM = parseFloat(peSettings.length) * (unitConverter[peSettings.unit] || 1e-3);
    if (!lenM || lenM === 0) return synthesizedSParamData;
    return applyPortExtension(synthesizedSParamData, lenM, parseFloat(peSettings.eeff) || 1);
  }, [synthesizedSParamData, peSettings]);

  // ---------------------------------------------------------------------------
  // Calibration-plane re-referencing for synthesized data
  // ---------------------------------------------------------------------------

  // Apply real SOLT 3-term calibration to the synthesized circuit S11.
  // The "fixture" is the set of components *outside* the calibration plane
  // (i.e., between the cal plane and the VNA port).  We simulate what the VNA
  // would measure for each standard by passing the standard through the fixture,
  // then compute the SOLT error terms and apply the correction to the raw S11.
  const calCorrectedSynData = useMemo(() => {
    if (!calSettings.enabled || calSettings.planeDP === null || calSettings.planeDP === undefined) return null;
    if (!synthesizedSParamData) return null;
    // Skip if any component in the circuit is a file-based S-param block.
    if (userCircuit.findIndex((c) => c.name === "sparam") !== -1) return null;

    const sf = convertSettingsToFloat(JSON.parse(JSON.stringify(settings)));
    const zo = sf.zo;

    // Components between the cal plane and the VNA port (the "fixture").
    // userCircuit is ordered from the load/termination (index 0) toward the VNA port
    // (highest index).  Components at indices > planeDP are therefore between the
    // cal plane and the VNA port.  When planeDP is the last component there is no
    // fixture (empty slice), which correctly gives identity error terms.
    const fixtureComps = userCircuit.slice(calSettings.planeDP + 1);

    // Frequency list taken from the already-synthesized raw data.
    const frequencies = Object.keys(synthesizedSParamData).map(Number);

    // Synthesize what the VNA would *measure* for each standard by running the
    // standard through the fixture.  Very-large/small R values approximate the
    // ideal Γ = +1 / −1 without requiring special-case math.
    const OPEN_APPROX_R  = 1e15; // R → ∞  →  Γ ≈ +1  (Open)
    const SHORT_APPROX_R = 1e-9; // R → 0   →  Γ ≈ −1  (Short)
    const openZ  = { real: OPEN_APPROX_R,  imaginary: 0 };
    const shortZ = { real: SHORT_APPROX_R, imaginary: 0 };
    const loadZ  = { real: zo,             imaginary: 0 };

    const measuredOpen  = synthesizeS11FromCircuit([openZ,  ...fixtureComps], frequencies, zo) ?? {};
    const measuredShort = synthesizeS11FromCircuit([shortZ, ...fixtureComps], frequencies, zo) ?? {};
    const measuredLoad  = synthesizeS11FromCircuit([loadZ,  ...fixtureComps], frequencies, zo) ?? {};

    const result = {};
    for (const fStr of Object.keys(synthesizedSParamData)) {
      const f = Number(fStr);

      // Actual (ideal) standard reflection coefficients at this frequency.
      let openActual, shortActual, loadActual;
      if (calSettings.useIdeal) {
        openActual  = idealStandards.open;
        shortActual = idealStandards.short;
        loadActual  = idealStandards.load;
      } else {
        openActual  = realisticOpenGamma(f, zo, calSettings.standards?.openParams  || {});
        shortActual = realisticShortGamma(f, zo, calSettings.standards?.shortParams || {});
        loadActual  = realisticLoadGamma(f, zo, calSettings.standards?.loadParams  || {});
      }

      const standards = {
        open:  { measured: polarToRectangular(measuredOpen[fStr]?.S11  ?? { magnitude: 1, angle: 0   }), actual: openActual  },
        short: { measured: polarToRectangular(measuredShort[fStr]?.S11 ?? { magnitude: 1, angle: 180 }), actual: shortActual },
        load:  { measured: polarToRectangular(measuredLoad[fStr]?.S11  ?? { magnitude: 0, angle: 0   }), actual: loadActual  },
      };

      const errorTerms = computeErrorTerms(standards, calSettings.calType || "OSL");

      const rawS11Rect = polarToRectangular(synthesizedSParamData[fStr].S11);
      const corrected  = applyCalibration(rawS11Rect, errorTerms);
      result[fStr] = { S11: rectangularToPolar(corrected) };
    }
    return result;
  }, [calSettings.enabled, calSettings.planeDP, calSettings.calType, calSettings.useIdeal, calSettings.standards, userCircuit, synthesizedSParamData, settings]);

  // Base synthesized data (before PE): use the cal-corrected view when calibration
  // plane is active, otherwise use the full circuit synthesis.
  const synBaseData = useMemo(() => {
    if (!sParameters && calSettings.enabled && calSettings.planeDP !== null && calCorrectedSynData) {
      return calCorrectedSynData;
    }
    return synthesizedSParamData;
  }, [sParameters, calSettings.enabled, calSettings.planeDP, calCorrectedSynData, synthesizedSParamData]);

  // Port-extension applied to the chosen base synthesized data
  const effectiveSynData = useMemo(() => {
    if (!synBaseData || !peSettings.enabled) return synBaseData;
    const lenM = parseFloat(peSettings.length) * (unitConverter[peSettings.unit] || 1e-3);
    if (!lenM || lenM === 0) return synBaseData;
    return applyPortExtension(synBaseData, lenM, parseFloat(peSettings.eeff) || 1);
  }, [synBaseData, peSettings]);

  // Unified S-param data: loaded file (corrected) or synthesized circuit response
  const effectiveSParamData = sParameters ? sParameters.data : effectiveSynData;

  // Calibration-plane synthesized trace: S11 of circuit truncated at planeDP
  const calPlaneSynData = useMemo(() => {
    if (!calSettings.enabled || calSettings.planeDP === null || calSettings.planeDP === undefined) return null;
    const truncated = userCircuit.slice(0, calSettings.planeDP + 1);
    if (truncated.length === 0) return null;
    if (truncated.findIndex((c) => c.name === "sparam") !== -1) return null;
    if (!synthesizedSParamData) return null;
    const frequencies = Object.keys(synthesizedSParamData).map(Number);
    const sf = convertSettingsToFloat(JSON.parse(JSON.stringify(settings)));
    return synthesizeS11FromCircuit(truncated, frequencies, sf.zo);
  }, [calSettings.enabled, calSettings.planeDP, userCircuit, synthesizedSParamData, settings]);

  // TDR computation (uses corrected s-params or synthesized data)
  const tdrData = useMemo(() => {
    if (!tdrSettings.enabled || !effectiveSParamData) return null;
    if (Object.keys(effectiveSParamData).length < 2) return null;
    return frequencyToTimeDomain(effectiveSParamData, tdrSettings.mode, tdrSettings.window);
  }, [tdrSettings.enabled, tdrSettings.mode, tdrSettings.window, effectiveSParamData]);

  // Uncertainty bands
  const uncertaintyBands = useMemo(() => {
    if (!uncertaintySettings.enabled || !effectiveSParamData) return null;
    const zo = parseFloat(settings.zo) || 50;
    return computeUncertaintyBands(effectiveSParamData, zo, uncertaintySettings);
  }, [uncertaintySettings, effectiveSParamData, settings.zo]);

  // Port extension length in metres (used by Graph for arc overlay)
  const peLength_m = useMemo(() => {
    if (!peSettings.enabled || !peSettings.length) return 0;
    return parseFloat(peSettings.length) * (unitConverter[peSettings.unit] || 1e-3);
  }, [peSettings]);

  // Gated s-param data (for Smith chart overlay when gating is active)
  const gatedSParamData = useMemo(() => {
    if (!tdrSettings.enabled || !tdrSettings.gateEnabled || !tdrData) return null;
    try {
      return applyGate(tdrData, tdrSettings.gateStart, tdrSettings.gateStop, tdrSettings.gateShape);
    } catch {
      return null;
    }
  }, [tdrSettings, tdrData]);

  // ---------------------------------------------------------------------------
  // Split-chart helpers
  // ---------------------------------------------------------------------------

  // Original (uncorrected) sparam component, used as the primary chart source in split mode
  const rawSParametersObject = sParamIndex === -1 ? null : userCircuit[sParamIndex];

  // Which corrections are currently active (used by VnaSmithChart for legend filtering)
  const activeStages = {
    cal: calSettings.enabled,
    deembed: deembedSettings.enabled,
    pe: peSettings.enabled,
    gating: tdrSettings.enabled && tdrSettings.gateEnabled,
  };

  // zo of the loaded S-param file; used by VnaSmithChart for reflToZ conversion
  const sParamZo = useMemo(() => {
    return sParameters?.settings?.zo || rawSParametersObject?.settings?.zo || settingsFloat.zo;
  }, [sParameters, rawSParametersObject, settingsFloat.zo]);

  // Is any VNA feature active that affects the displayed data?
  // Works with both loaded S-param files and synthesized circuit data.
  const anyVnaActive =
    effectiveSParamData != null &&
    (activeStages.cal || activeStages.deembed || activeStages.pe || activeStages.gating || uncertaintySettings.enabled);

  // Intermediate trace data keyed by stage name, for the second Smith chart.
  // When no file is loaded, fall back to synthesized equivalents.
  const intermediateTraces = {
    raw: rawSParamData ?? synthesizedSParamData,
    afterCal: activeStages.cal ? (afterCalData ?? calCorrectedSynData) : null,
    afterDeembed: activeStages.deembed ? afterDeembedData : null,
    afterPe: activeStages.pe ? (afterPeData ?? effectiveSynData) : null,
    afterGating: activeStages.gating ? gatedSParamData : null,
  };

  // In overlay mode, show the raw/uncorrected trace behind the corrected one —
  // only meaningful when a file is loaded (synthesized data has no separate raw trace).
  const backgroundSParamData = !splitSmithChart && rawSParamData != null && (activeStages.cal || activeStages.deembed || activeStages.pe || activeStages.gating) ? rawSParamData : null;
  // console.log("chosenNoiseParameter", chosenNoiseParameter);

  const handleSnackbarClick = () => {
    setSettings({ ...initialState });
    setUserCircuit([{ ...initialCircuit[0] }]);
    setUrlSnackbar(false);
  };

  function LetUserKnowAboutURL() {
    return (
      <Snackbar
        open={urlSnackbar}
        autoHideDuration={10000}
        onClose={() => setUrlSnackbar(false)}
        anchorOrigin={{ vertical: "top", horizontal: "right" }}
        message="This Snackbar will be dismissed in 5 seconds."
      >
        <SnackbarContent
          message={t("app.urlLoadedSnackbar")}
          sx={{
            backgroundColor: "#2196f3",
            color: "#fff",
            cursor: "pointer", // Indicate clickable
            maxWidth: 200,
          }}
          onClick={handleSnackbarClick}
        />
      </Snackbar>
    );
  }

  //open the snackbar after 1 seconds if there is state in the URL
  useEffect(() => {
    const timer = setTimeout(() => {
      if (urlContainsState) {
        setUrlSnackbar(true);
      }
    }, 1000); // 1 seconds
    // Optional: Clean up the timer if the component unmounts early
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    document.title = t("meta.pageTitle");
    const meta = document.querySelector('meta[name="description"]');
    if (meta) meta.setAttribute("content", t("meta.pageDescription"));
  }, [i18n.language, t]);

  return (
    <ThemeProvider theme={theme}>
      <LetUserKnowAboutURL />
      <NavBar />
      <Typography sx={{ color: "rgb(37, 50, 64)", mx: 3, mt: 1 }}>{t("app.intro")}</Typography>
      <Box sx={{ flexGrow: 1, mx: { xs: 0, sm: 1, lg: 2 }, mt: 1 }}>
        <Grid container spacing={{ lg: 2, xs: 1 }}>
          <Grid size={{ sm: 12, md: 6 }}>
            <Card>
              <CardContent>
                <Circuit
                  userCircuit={userCircuit}
                  setUserCircuit={setUserCircuit}
                  frequency={numericalFrequency}
                  setPlotType={setPlotType}
                  setSettings={setSettings}
                  showIdeal={showIdeal}
                  calPlaneDP={calSettings.enabled ? calSettings.planeDP : null}
                />
              </CardContent>
            </Card>
          </Grid>
          <Grid size={{ xs: 12, sm: 12, md: 6, lg: 6 }}>
            <Card sx={{ padding: 0 }}>
              <Graph
                zResultsSrc={multiZResults}
                zo={settingsFloat.zo}
                spanResults={spanResults}
                qCircles={settings.qCircles}
                vswrCircles={settings.vswrCircles}
                nfCircles={settings.nfCircles}
                gainInCircles={settings.gainInCircles}
                gainOutCircles={settings.gainOutCircles}
                zMarkers={settings.zMarkers}
                reflection_real={processedImpedanceResults.refReal}
                reflection_imag={processedImpedanceResults.refImag}
                plotType={plotType}
                sParameters={splitSmithChart ? rawSParametersObject : sParameters}
                chosenSparameter={chosenSparameter}
                freqUnit={settings.frequencyUnit}
                frequency={numericalFrequency}
                chosenNoiseParameter={chosenNoiseParameter}
                nonIdealUsed={nonIdealUsed}
                showIdeal={showIdeal}
                setShowIdeal={setShowIdeal}
                calPlaneSynData={splitSmithChart ? null : calPlaneSynData}
                calPlaneDP={calSettings.enabled ? calSettings.planeDP : null}
                calPlaneEnabled={splitSmithChart ? false : calSettings.enabled}
                peLength_m={splitSmithChart ? 0 : peLength_m}
                peEeff={parseFloat(peSettings.eeff) || 1}
                peEnabled={splitSmithChart ? false : peSettings.enabled}
                prePeSynData={splitSmithChart ? null : (sParameters ? null : synBaseData)}
                uncertaintyBands={splitSmithChart ? null : uncertaintyBands}
                gatedSParamData={splitSmithChart ? null : gatedSParamData}
                tdrData={tdrData}
                tdrSettings={tdrSettings}
                backgroundSParamData={backgroundSParamData}
                effectiveSpData={splitSmithChart ? null : effectiveSParamData}
              />
            </Card>
          </Grid>
          {splitSmithChart && anyVnaActive && (
            <Grid size={{ xs: 12, sm: 12, md: 6, lg: 6 }}>
              <Card sx={{ padding: 0 }}>
                <VnaSmithChart
                  zo={settingsFloat.zo}
                  sParamZo={sParamZo}
                  intermediateTraces={intermediateTraces}
                  visibleStages={visibleStages}
                  setVisibleStages={setVisibleStages}
                  activeStages={activeStages}
                />
              </Card>
            </Grid>
          )}
          <Grid size={{ xs: 12, sm: 6, md: 6 }}>
            <Card>
              <CardContent>
                {sParamIndex !== -1 && (
                  <Box display="flex" justifyContent="center" sx={{ mb: 2 }}>
                    <ToggleButtonGroup value={plotType} exclusive onChange={(e, newP) => setPlotType(newP)}>
                      <ToggleButton value="sparam">{t("app.plotSparam")}</ToggleButton>
                      <ToggleButton value="impedance">{s1pIndex !== -1 ? t("app.plotImpedanceS1p") : t("app.plotImpedanceS2p")}</ToggleButton>
                    </ToggleButtonGroup>
                  </Box>
                )}
                <Results
                  zProc={processedImpedanceResults}
                  spanResults={spanResults}
                  freqUnit={settings.frequencyUnit}
                  plotType={plotType}
                  sParameters={sParameters}
                  gainResults={gainArray}
                  noiseArray={noiseArray}
                  RefIn={RefIn}
                  zo={settingsFloat.zo}
                  uncertaintyBands={uncertaintyBands}
                />
              </CardContent>
            </Card>
          </Grid>
          <Grid size={{ xs: 12, sm: 6, md: 6 }}>
            <Card>
              <CardContent>
                <Settings
                  settings={settings}
                  setSettings={setSettings}
                  usedF={numericalFrequency}
                  chosenSparameter={chosenSparameter}
                  chosenNoiseParameter={chosenNoiseParameter}
                />
              </CardContent>
            </Card>
          </Grid>
          <Grid size={12}>
            <VnaTools
              calSettings={calSettings}
              setCalSettings={setCalSettings}
              peSettings={peSettings}
              setPeSettings={setPeSettings}
              deembedSettings={deembedSettings}
              setDeembedSettings={setDeembedSettings}
              tdrSettings={tdrSettings}
              setTdrSettings={setTdrSettings}
              uncertaintySettings={uncertaintySettings}
              setUncertaintySettings={setUncertaintySettings}
              uncertaintyBands={uncertaintyBands}
              sparamData={effectiveSParamData}
              isSynthesized={!sParameters}
              circuitLength={userCircuit.length}
              zo={settingsFloat.zo}
              centerFrequency={numericalFrequency}
              splitSmithChart={splitSmithChart}
              setSplitSmithChart={setSplitSmithChart}
              visibleStages={visibleStages}
              setVisibleStages={setVisibleStages}
              activeStages={activeStages}
            />
          </Grid>
          <Grid size={12}>
            <Tutorials />
          </Grid>
          <Grid size={12}>
            <Equations />
          </Grid>
          <Grid size={12}>
            <ReleaseNotes />
          </Grid>
          <Grid size={12}>
            <Card>
              <CardContent>
                <Box sx={{ mb: 2 }}>
                  <Link
                    href="https://chatgpt.com/g/g-p-69ee7cba04888191bc878377f29b9f76-onlinesmithchart-helper/project"
                    target="_blank"
                    rel="noopener noreferrer"
                    color="#1976d2"
                    underline="always"
                  >
                    Ask OnlineSmithChart Helper (ChatGPT)
                  </Link>
                </Box>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <Typography>{t("app.commentsTitle")}</Typography>
                  <Link
                    href="https://www.microwave-master.com/contact-us/"
                    onClick={() => gtag("event", "click_microwave_maser")}
                    target="_blank"
                    color="inherit"
                  >
                    {t("app.supportLink")}
                  </Link>
                </div>
                {!import.meta.env.DEV && <Comments website-id="12282" page-id="/smith_chart/" />}
              </CardContent>
            </Card>
          </Grid>
        </Grid>
      </Box>
      <Footer />
    </ThemeProvider>
  );
}

export default App;
