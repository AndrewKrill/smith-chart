/**
 * VnaTools.jsx
 * A collapsible panel with 4 tabs for teaching VNA concepts:
 *   1. Calibration (SOLT, ideal vs realistic standards, cal-plane offset)
 *   2. Port Extension (electrical delay)
 *   3. Embedding / De-embedding (T-matrix cascade)
 *   4. Time Domain / TDR / Gating
 */
import { useState, useRef, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";

import Accordion from "@mui/material/Accordion";
import AccordionSummary from "@mui/material/AccordionSummary";
import AccordionDetails from "@mui/material/AccordionDetails";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import Box from "@mui/material/Box";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import Typography from "@mui/material/Typography";
import Grid from "@mui/material/Grid";
import TextField from "@mui/material/TextField";
import Select from "@mui/material/Select";
import MenuItem from "@mui/material/MenuItem";
import InputAdornment from "@mui/material/InputAdornment";
import Button from "@mui/material/Button";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import FormControlLabel from "@mui/material/FormControlLabel";
import Switch from "@mui/material/Switch";
import Slider from "@mui/material/Slider";
import Collapse from "@mui/material/Collapse";
import Alert from "@mui/material/Alert";
import Tooltip from "@mui/material/Tooltip";
import Divider from "@mui/material/Divider";
import Chip from "@mui/material/Chip";

import UplotReact from "uplot-react";
import "uplot/dist/uPlot.min.css";

import { parseInput, parseSIInput, speedOfLight, unitConverter } from "./commonFunctions.js";
import { frequencyToTimeDomain, applyGate, gateStartStopToCS, gateCsToStartStop, windowInfo, computeTdrResolution } from "./tdr.js";
import { extensionDelay } from "./portExtension.js";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function Row({ children, spacing = 1 }) {
  return (
    <Grid container spacing={spacing} alignItems="center" sx={{ mb: 1 }}>
      {children}
    </Grid>
  );
}

function LabelCell({ children, size = 3 }) {
  return (
    <Grid size={{ xs: 12, sm: size }}>
      <Typography variant="body2" color="text.secondary">
        {children}
      </Typography>
    </Grid>
  );
}

function FieldCell({ children, size = 9 }) {
  return (
    <Grid size={{ xs: 12, sm: size }} sx={{ display: "flex", gap: 1 }}>
      {children}
    </Grid>
  );
}

const lengthUnitOpts = ["m", "mm", "um", "deg", "λ"];

function LengthInput({ label, value, unit, onChange, onUnitChange }) {
  return (
    <Box sx={{ display: "flex", gap: 1, alignItems: "center", flex: 1 }}>
      <TextField label={label} size="small" value={value} onChange={(e) => onChange(parseInput(e.target.value))} sx={{ flex: 1 }} />
      <Select size="small" value={unit} onChange={(e) => onUnitChange(e.target.value)} sx={{ minWidth: 60 }}>
        {lengthUnitOpts.map((u) => (
          <MenuItem key={u} value={u}>
            {u}
          </MenuItem>
        ))}
      </Select>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Tab 1: Calibration
// ---------------------------------------------------------------------------
const CAL_TYPES = ["OSL", "OS", "OL", "SL", "O", "S", "L"];

// Controlled input that stores a string locally and commits as SI base units on blur/Enter
function SITextField({ label, siValue, multiplier, unit, onCommit, ...props }) {
  const [localStr, setLocalStr] = useState(siValue != null ? String((siValue / multiplier).toPrecision(6).replace(/\.?0+$/, "")) : "0");
  useEffect(() => {
    setLocalStr(siValue != null ? String((siValue / multiplier).toPrecision(6).replace(/\.?0+$/, "")) : "0");
  }, [siValue, multiplier]);
  function commit() {
    const parsed = parseFloat(parseInput(localStr));
    onCommit(isNaN(parsed) ? 0 : parsed * multiplier);
  }
  return (
    <TextField
      {...props}
      size="small"
      label={label ? `${label} (${unit})` : undefined}
      value={localStr}
      onChange={(e) => setLocalStr(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
    />
  );
}

function CalibrationTab({ calSettings, setCalSettings, circuitLength }) {
  const { t } = useTranslation();
  const cs = calSettings;
  const set = (key, val) => setCalSettings((s) => ({ ...s, [key]: val }));
  const setStd = (key, val) =>
    setCalSettings((s) => ({
      ...s,
      standards: { ...s.standards, [key]: val },
    }));

  return (
    <Box>
      <Row>
        <LabelCell>{t("vna.cal.enabled")}</LabelCell>
        <FieldCell>
          <FormControlLabel
            control={<Switch checked={cs.enabled} onChange={(e) => set("enabled", e.target.checked)} />}
            label={cs.enabled ? t("vna.cal.on") : t("vna.cal.off")}
          />
        </FieldCell>
      </Row>

      <Collapse in={cs.enabled}>
        {/* Cal type */}
        <Row>
          <LabelCell>{t("vna.cal.calType")}</LabelCell>
          <FieldCell>
            <ToggleButtonGroup value={cs.calType} exclusive onChange={(_, v) => v && set("calType", v)} size="small">
              {CAL_TYPES.map((ct) => (
                <ToggleButton key={ct} value={ct}>
                  {ct}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
          </FieldCell>
        </Row>

        {/* Ideal vs Realistic */}
        <Row>
          <LabelCell>{t("vna.cal.standardType")}</LabelCell>
          <FieldCell>
            <ToggleButtonGroup
              value={cs.useIdeal ? "ideal" : "realistic"}
              exclusive
              onChange={(_, v) => v && set("useIdeal", v === "ideal")}
              size="small"
            >
              <ToggleButton value="ideal">{t("vna.cal.ideal")}</ToggleButton>
              <ToggleButton value="realistic">{t("vna.cal.realistic")}</ToggleButton>
            </ToggleButtonGroup>
          </FieldCell>
        </Row>

        {/* Realistic params (only when realistic selected) */}
        <Collapse in={!cs.useIdeal}>
          <Box sx={{ pl: 2, borderLeft: "3px solid #e0e0e0", mb: 1 }}>
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1 }}>
              {t("vna.cal.realisticDesc")}
            </Typography>

            {/* Open params */}
            <Typography variant="body2" sx={{ fontWeight: "bold" }}>
              {t("vna.cal.openStd")}
            </Typography>
            <Row>
              <LabelCell size={4}>{t("vna.cal.fringe_c0")}</LabelCell>
              <FieldCell size={8}>
                <SITextField
                  label="C0"
                  unit="pF"
                  siValue={cs.standards?.openParams?.c0 ?? 0}
                  multiplier={1e-12}
                  onCommit={(v) => setStd("openParams", { ...(cs.standards?.openParams || {}), c0: v })}
                />
              </FieldCell>
            </Row>

            {/* Short params */}
            <Typography variant="body2" sx={{ fontWeight: "bold", mt: 1 }}>
              {t("vna.cal.shortStd")}
            </Typography>
            <Row>
              <LabelCell size={4}>{t("vna.cal.residual_l0")}</LabelCell>
              <FieldCell size={8}>
                <SITextField
                  label="L0"
                  unit="pH"
                  siValue={cs.standards?.shortParams?.l0 ?? 0}
                  multiplier={1e-12}
                  onCommit={(v) => setStd("shortParams", { ...(cs.standards?.shortParams || {}), l0: v })}
                />
              </FieldCell>
            </Row>

            {/* Load params */}
            <Typography variant="body2" sx={{ fontWeight: "bold", mt: 1 }}>
              {t("vna.cal.loadStd")}
            </Typography>
            <Row>
              <LabelCell size={4}>{t("vna.cal.r_offset")}</LabelCell>
              <FieldCell size={8}>
                <SITextField
                  label="R"
                  unit="Ω"
                  siValue={cs.standards?.loadParams?.r_offset ?? 0}
                  multiplier={1}
                  onCommit={(v) => setStd("loadParams", { ...(cs.standards?.loadParams || {}), r_offset: v })}
                />
              </FieldCell>
            </Row>
          </Box>
        </Collapse>

        <Divider sx={{ my: 1 }} />

        {/* Calibration plane selector */}
        <Typography variant="subtitle2" sx={{ mb: 1 }}>
          {t("vna.cal.planeSectionTitle")}
        </Typography>
        <Row>
          <LabelCell>{t("vna.cal.planeDPLabel")}</LabelCell>
          <FieldCell>
            <Select
              size="small"
              value={cs.planeDP ?? ""}
              onChange={(e) => set("planeDP", e.target.value === "" ? null : Number(e.target.value))}
              displayEmpty
              sx={{ minWidth: 120 }}
            >
              <MenuItem value="">{t("vna.cal.planeDPNone")}</MenuItem>
              {Array.from({ length: circuitLength }, (_, idx) => (
                <MenuItem key={idx} value={idx}>
                  DP{idx}
                </MenuItem>
              ))}
            </Select>
          </FieldCell>
        </Row>
        <Alert severity="info" sx={{ mt: 1 }}>
          {t("vna.cal.planeDPDesc")}
        </Alert>
      </Collapse>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Tab 2: Port Extension
// ---------------------------------------------------------------------------
function PortExtensionTab({ peSettings, setPeSettings, centerFrequency }) {
  const { t } = useTranslation();
  const pe = peSettings;
  const set = (key, val) => setPeSettings((s) => ({ ...s, [key]: val }));

  const delayNs = useMemo(() => {
    const lenM = parseFloat(pe.length) * (unitConverter[pe.unit] || 1);
    return (extensionDelay(lenM, parseFloat(pe.eeff) || 1) * 1e9).toFixed(3);
  }, [pe.length, pe.unit, pe.eeff]);

  const delayDeg = useMemo(() => {
    if (!centerFrequency || centerFrequency <= 0) return null;
    const lenM = parseFloat(pe.length) * (unitConverter[pe.unit] || 1);
    const delay_s = extensionDelay(lenM, parseFloat(pe.eeff) || 1);
    return (delay_s * centerFrequency * 360).toFixed(1);
  }, [pe.length, pe.unit, pe.eeff, centerFrequency]);

  return (
    <Box>
      <Row>
        <LabelCell>{t("vna.pe.enabled")}</LabelCell>
        <FieldCell>
          <FormControlLabel
            control={<Switch checked={pe.enabled} onChange={(e) => set("enabled", e.target.checked)} />}
            label={pe.enabled ? t("vna.cal.on") : t("vna.cal.off")}
          />
        </FieldCell>
      </Row>

      <Collapse in={pe.enabled}>
        <Row>
          <LabelCell>{t("vna.pe.length")}</LabelCell>
          <FieldCell>
            <LengthInput
              label={t("common.length")}
              value={pe.length}
              unit={pe.unit}
              onChange={(v) => set("length", v)}
              onUnitChange={(u) => set("unit", u)}
            />
            <TextField label="Zo (Ω)" size="small" value={pe.zo} onChange={(e) => set("zo", parseInput(e.target.value))} sx={{ width: 80 }} />
            <TextField label="εeff" size="small" value={pe.eeff} onChange={(e) => set("eeff", parseInput(e.target.value))} sx={{ width: 80 }} />
          </FieldCell>
        </Row>

        <Alert severity="info" sx={{ mt: 1 }}>
          {t("vna.pe.delayInfo", { delay: delayNs })}
          {delayDeg !== null ? ` (${delayDeg}° at ${t("vna.pe.centerFreq")})` : ""}
        </Alert>

        <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: "block" }}>
          {t("vna.pe.desc")}
        </Typography>

        <Button variant="outlined" size="small" sx={{ mt: 1 }} onClick={() => set("length", 0)}>
          {t("vna.pe.clear")}
        </Button>
      </Collapse>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Tab 3: Embedding / De-embedding
// ---------------------------------------------------------------------------
function DeembedTab({ deembedSettings, setDeembedSettings }) {
  const { t } = useTranslation();
  const de = deembedSettings;
  const set = (key, val) => setDeembedSettings((s) => ({ ...s, [key]: val }));

  return (
    <Box>
      <Row>
        <LabelCell>{t("vna.de.enabled")}</LabelCell>
        <FieldCell>
          <FormControlLabel
            control={<Switch checked={de.enabled} onChange={(e) => set("enabled", e.target.checked)} />}
            label={de.enabled ? t("vna.cal.on") : t("vna.cal.off")}
          />
        </FieldCell>
      </Row>

      <Collapse in={de.enabled}>
        {/* Embed / De-embed mode */}
        <Row>
          <LabelCell>{t("vna.de.mode")}</LabelCell>
          <FieldCell>
            <ToggleButtonGroup value={de.mode} exclusive onChange={(_, v) => v && set("mode", v)} size="small">
              <ToggleButton value="deembed">{t("vna.de.deembed")}</ToggleButton>
              <ToggleButton value="embed">{t("vna.de.embed")}</ToggleButton>
            </ToggleButtonGroup>
          </FieldCell>
        </Row>

        {/* Fixture source */}
        <Row>
          <LabelCell>{t("vna.de.fixtureSource")}</LabelCell>
          <FieldCell>
            <ToggleButtonGroup value={de.fixtureType} exclusive onChange={(_, v) => v && set("fixtureType", v)} size="small">
              <ToggleButton value="tline">{t("vna.de.tline")}</ToggleButton>
              <ToggleButton value="sparam">{t("vna.de.sparam")}</ToggleButton>
            </ToggleButtonGroup>
          </FieldCell>
        </Row>

        {/* T-line fixture params */}
        <Collapse in={de.fixtureType === "tline"}>
          <Row>
            <LabelCell>{t("vna.de.fixtureLength")}</LabelCell>
            <FieldCell>
              <LengthInput
                label={t("common.length")}
                value={de.fixtureLength}
                unit={de.fixtureLengthUnit}
                onChange={(v) => set("fixtureLength", v)}
                onUnitChange={(u) => set("fixtureLengthUnit", u)}
              />
              <TextField
                label="Zo (Ω)"
                size="small"
                value={de.fixtureZo}
                onChange={(e) => set("fixtureZo", parseInput(e.target.value))}
                sx={{ width: 80 }}
              />
              <TextField
                label="εeff"
                size="small"
                value={de.fixtureEeff}
                onChange={(e) => set("fixtureEeff", parseInput(e.target.value))}
                sx={{ width: 80 }}
              />
            </FieldCell>
          </Row>
        </Collapse>

        {/* S-param fixture upload */}
        <Collapse in={de.fixtureType === "sparam"}>
          <Alert severity="warning" sx={{ mt: 1 }}>
            {t("vna.de.sparamHint")}
          </Alert>
        </Collapse>

        <Alert severity="info" sx={{ mt: 1 }}>
          {de.mode === "deembed" ? t("vna.de.deembedDesc") : t("vna.de.embedDesc")}
        </Alert>
      </Collapse>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Tab 4: Time Domain / TDR / Gating
// ---------------------------------------------------------------------------
const TDR_MODES = ["bandpass", "lowpass_impulse", "lowpass_step"];
const TDR_WINDOWS = ["rectangular", "hamming", "hanning", "blackman", "kaiser6", "kaiser13"];
const GATE_SHAPES = ["minimum", "nominal", "wide", "maximum"];

function TdrTab({ tdrSettings, setTdrSettings, sparamData, isSynthesized, zo }) {
  const { t } = useTranslation();
  const ts = tdrSettings;
  const set = (key, val) => setTdrSettings((s) => ({ ...s, [key]: val }));
  const containerRef = useRef(null);
  const [chartWidth, setChartWidth] = useState(500);

  const hasData = sparamData && Object.keys(sparamData).length >= 2;

  // Compute TDR time-domain data
  const tdData = useMemo(() => {
    if (!hasData) return null;
    return frequencyToTimeDomain(sparamData, ts.mode, ts.window);
  }, [sparamData, ts.mode, ts.window, hasData]);

  // Resolution info
  const resInfo = useMemo(() => {
    if (!hasData) return null;
    return computeTdrResolution(sparamData, ts.window, ts.velocityFactor || 1);
  }, [sparamData, ts.window, ts.velocityFactor, hasData]);

  // Gated data
  const gatedData = useMemo(() => {
    if (!tdData || !ts.gateEnabled) return null;
    return applyGate(tdData, ts.gateStart || 0, ts.gateStop || 1e-9, ts.gateShape);
  }, [tdData, ts.gateEnabled, ts.gateStart, ts.gateStop, ts.gateShape]);

  // Chart resize
  useEffect(() => {
    function handleResize() {
      if (containerRef.current) setChartWidth(containerRef.current.offsetWidth || 500);
    }
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // Build uPlot data for time-domain plot
  const tdPlotData = useMemo(() => {
    if (!tdData || tdData.timeAxis.length === 0) return null;
    const tNs = tdData.timeAxis.map((t) => t * 1e9); // convert to ns
    const mag = tdData.magnitude;
    // Impedance from reflection: Z = zo*(1+ρ)/(1−ρ), but clamp ρ < 1
    const zArr = mag.map((rho) => {
      const r = Math.min(rho, 0.9999);
      return (zo * (1 + r)) / (1 - r);
    });
    // Shade gate region: build a gate indicator array (0 or 1)
    const gateArr = tNs.map((tn) => {
      if (!ts.gateEnabled) return null;
      const ts_ns = (ts.gateStart || 0) * 1e9;
      const te_ns = (ts.gateStop || 0) * 1e9;
      return tn >= ts_ns && tn <= te_ns ? 1 : null;
    });
    return { tNs, mag, zArr, gateArr };
  }, [tdData, ts.gateEnabled, ts.gateStart, ts.gateStop, zo]);

  const tdChartOptions = useMemo(() => {
    if (!tdPlotData) return null;
    return {
      width: chartWidth,
      height: 300,
      series: [
        { label: "Time (ns)" },
        { label: "|Γ(t)|", stroke: "#1f77b4", width: 2, scale: "y" },
        { label: "Z(t) (Ω)", stroke: "#ff7f0e", width: 1, scale: "y2" },
      ],
      axes: [{ label: "Time (ns)" }, { scale: "y", label: "|Γ(t)|" }, { scale: "y2", side: 1, label: "Z(t) (Ω)" }],
      scales: { x: { time: false }, y: { auto: true }, y2: { auto: true } },
    };
  }, [chartWidth, tdPlotData]);

  const tdChartData = useMemo(() => {
    if (!tdPlotData) return null;
    return [tdPlotData.tNs, tdPlotData.mag, tdPlotData.zArr];
  }, [tdPlotData]);

  // Gate start/stop/center/span linked fields
  const gateCS = gateStartStopToCS(ts.gateStart || 0, ts.gateStop || 1e-9);
  const gateCenter_ns = gateCS.center * 1e9;
  const gateSpan_ns = gateCS.span * 1e9;

  function updateGateStartStop(start_s, stop_s) {
    setTdrSettings((s) => ({ ...s, gateStart: start_s, gateStop: stop_s }));
  }

  return (
    <Box>
      {/* Enable toggle */}
      <Row>
        <LabelCell>{t("vna.tdr.enabled")}</LabelCell>
        <FieldCell>
          <FormControlLabel
            control={<Switch checked={ts.enabled} onChange={(e) => set("enabled", e.target.checked)} />}
            label={ts.enabled ? t("vna.cal.on") : t("vna.cal.off")}
          />
        </FieldCell>
      </Row>

      <Collapse in={ts.enabled}>
        {/* Mode */}
        <Row>
          <LabelCell>{t("vna.tdr.mode")}</LabelCell>
          <FieldCell>
            <ToggleButtonGroup value={ts.mode} exclusive onChange={(_, v) => v && set("mode", v)} size="small">
              <ToggleButton value="bandpass">{t("vna.tdr.bandpass")}</ToggleButton>
              <ToggleButton value="lowpass_impulse">{t("vna.tdr.lpImpulse")}</ToggleButton>
              <ToggleButton value="lowpass_step">{t("vna.tdr.lpStep")}</ToggleButton>
            </ToggleButtonGroup>
          </FieldCell>
        </Row>

        {/* Window */}
        <Row>
          <LabelCell>{t("vna.tdr.window")}</LabelCell>
          <FieldCell>
            <Select size="small" value={ts.window} onChange={(e) => set("window", e.target.value)} sx={{ minWidth: 140 }}>
              {TDR_WINDOWS.map((w) => (
                <MenuItem key={w} value={w}>
                  {windowInfo[w]?.label ?? w}
                </MenuItem>
              ))}
            </Select>
            {windowInfo[ts.window] && (
              <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap", alignItems: "center" }}>
                <Chip size="small" label={`Sidelobe: ${windowInfo[ts.window].sidelobe_dB} dB`} />
                <Chip size="small" label={`Resolution factor: ×${windowInfo[ts.window].resolutionFactor}`} />
              </Box>
            )}
          </FieldCell>
        </Row>

        {/* Resolution info */}
        {resInfo && (
          <Alert severity="info" sx={{ my: 1 }}>
            {t("vna.tdr.resolutionInfo", {
              res_ns: (resInfo.resolution_s * 1e9).toFixed(3),
              res_mm: (resInfo.resolution_m * 1e3).toFixed(2),
              span_ns: (resInfo.maxTime_s * 1e9).toFixed(1),
            })}
          </Alert>
        )}

        {/* Source note + synthesis bandwidth controls */}
        <Alert severity={isSynthesized ? "info" : "success"} sx={{ my: 1 }}>
          {isSynthesized ? t("vna.tdr.synthSource") : t("vna.tdr.loadedSource")}
        </Alert>

        {isSynthesized && (
          <Box sx={{ pl: 2, borderLeft: "3px solid #e0e0e0", mb: 1 }}>
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1 }}>
              {t("vna.tdr.synthBandwidth")}
            </Typography>
            <Grid container spacing={1}>
              <Grid size={{ xs: 12, sm: 4 }}>
                <TextField
                  label={t("vna.tdr.synthFmin")}
                  size="small"
                  value={ts.synthFmin ?? ""}
                  onChange={(e) => {
                    const v = e.target.value === "" ? null : parseFloat(parseInput(e.target.value));
                    set("synthFmin", isNaN(v) ? null : v);
                  }}
                  fullWidth
                />
              </Grid>
              <Grid size={{ xs: 12, sm: 4 }}>
                <TextField
                  label={t("vna.tdr.synthFmax")}
                  size="small"
                  value={ts.synthFmax ?? ""}
                  onChange={(e) => {
                    const v = e.target.value === "" ? null : parseFloat(parseInput(e.target.value));
                    set("synthFmax", isNaN(v) ? null : v);
                  }}
                  fullWidth
                />
              </Grid>
              <Grid size={{ xs: 12, sm: 4 }}>
                <TextField
                  label={t("vna.tdr.synthPoints")}
                  size="small"
                  value={ts.synthPoints ?? 201}
                  onChange={(e) => {
                    const v = parseInt(parseInput(e.target.value), 10);
                    set("synthPoints", isNaN(v) ? 201 : Math.max(3, v));
                  }}
                  fullWidth
                />
              </Grid>
            </Grid>
          </Box>
        )}

        {hasData ? (
          <>
            {/* Time-domain plot */}
            <Typography variant="subtitle2" sx={{ mt: 2, mb: 1 }}>
              {t("vna.tdr.plotTitle")}
            </Typography>
            <div ref={containerRef} style={{ width: "100%" }}>
              {tdChartOptions && tdChartData && <UplotReact options={tdChartOptions} data={tdChartData} />}
            </div>

            {/* Cal-plane and gate markers info */}
            {ts.gateEnabled && gatedData && (
              <Alert severity="success" sx={{ mt: 1 }}>
                {t("vna.tdr.gateApplied")}
              </Alert>
            )}

            <Divider sx={{ my: 2 }} />

            {/* Gate sub-panel */}
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              {t("vna.tdr.gateTitle")}
            </Typography>
            <Row>
              <LabelCell>{t("vna.tdr.gateEnabled")}</LabelCell>
              <FieldCell>
                <FormControlLabel
                  control={<Switch checked={ts.gateEnabled} onChange={(e) => set("gateEnabled", e.target.checked)} />}
                  label={ts.gateEnabled ? t("vna.cal.on") : t("vna.cal.off")}
                />
              </FieldCell>
            </Row>

            <Collapse in={ts.gateEnabled}>
              {/* Start / Stop / Center / Span linked fields */}
              <Grid container spacing={1} sx={{ mb: 1 }}>
                <Grid size={{ xs: 6, sm: 3 }}>
                  <TextField
                    label={t("vna.tdr.gateStart") + " (ns)"}
                    size="small"
                    value={((ts.gateStart || 0) * 1e9).toFixed(4)}
                    onChange={(e) => {
                      const ns = parseFloat(parseInput(e.target.value)) || 0;
                      updateGateStartStop(ns * 1e-9, ts.gateStop || 1e-9);
                    }}
                    fullWidth
                  />
                </Grid>
                <Grid size={{ xs: 6, sm: 3 }}>
                  <TextField
                    label={t("vna.tdr.gateStop") + " (ns)"}
                    size="small"
                    value={((ts.gateStop || 1e-9) * 1e9).toFixed(4)}
                    onChange={(e) => {
                      const ns = parseFloat(parseInput(e.target.value)) || 0;
                      updateGateStartStop(ts.gateStart || 0, ns * 1e-9);
                    }}
                    fullWidth
                  />
                </Grid>
                <Grid size={{ xs: 6, sm: 3 }}>
                  <TextField
                    label={t("vna.tdr.gateCenter") + " (ns)"}
                    size="small"
                    value={gateCenter_ns.toFixed(4)}
                    onChange={(e) => {
                      const c_ns = parseFloat(parseInput(e.target.value)) || 0;
                      const { tStart, tStop } = gateCsToStartStop(c_ns * 1e-9, gateCS.span);
                      updateGateStartStop(tStart, tStop);
                    }}
                    fullWidth
                  />
                </Grid>
                <Grid size={{ xs: 6, sm: 3 }}>
                  <TextField
                    label={t("vna.tdr.gateSpan") + " (ns)"}
                    size="small"
                    value={gateSpan_ns.toFixed(4)}
                    onChange={(e) => {
                      const span_ns = parseFloat(parseInput(e.target.value)) || 0;
                      const { tStart, tStop } = gateCsToStartStop(gateCS.center, span_ns * 1e-9);
                      updateGateStartStop(tStart, tStop);
                    }}
                    fullWidth
                  />
                </Grid>
              </Grid>

              <Row>
                <LabelCell>{t("vna.tdr.gateShape")}</LabelCell>
                <FieldCell>
                  <ToggleButtonGroup value={ts.gateShape} exclusive onChange={(_, v) => v && set("gateShape", v)} size="small">
                    {GATE_SHAPES.map((g) => (
                      <ToggleButton key={g} value={g}>
                        {t(`vna.tdr.gate_${g}`)}
                      </ToggleButton>
                    ))}
                  </ToggleButtonGroup>
                </FieldCell>
              </Row>

              <Alert severity="info" sx={{ mt: 1 }}>
                {t("vna.tdr.gateHint")}
              </Alert>
            </Collapse>
          </>
        ) : null}
      </Collapse>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Tab 5: Noise Floor & Uncertainty
// ---------------------------------------------------------------------------
function UncertaintyTab({ uncertaintySettings, setUncertaintySettings }) {
  const { t } = useTranslation();
  const us = uncertaintySettings;
  const set = (key, val) => setUncertaintySettings((s) => ({ ...s, [key]: val }));

  return (
    <Box>
      <Row>
        <LabelCell>{t("vna.unc.enabled")}</LabelCell>
        <FieldCell>
          <FormControlLabel
            control={<Switch checked={us.enabled} onChange={(e) => set("enabled", e.target.checked)} />}
            label={us.enabled ? t("vna.cal.on") : t("vna.cal.off")}
          />
        </FieldCell>
      </Row>

      <Collapse in={us.enabled}>
        <Row>
          <LabelCell>{t("vna.unc.noiseFloor")}</LabelCell>
          <FieldCell>
            <TextField
              size="small"
              label={t("vna.unc.noiseFloor")}
              value={us.noiseFloor_dB}
              onChange={(e) => set("noiseFloor_dB", parseInput(e.target.value))}
              slotProps={{ input: { endAdornment: <InputAdornment position="end">dBc</InputAdornment> } }}
              sx={{ width: 150 }}
            />
          </FieldCell>
        </Row>

        <Row>
          <LabelCell>{t("vna.unc.repeatability")}</LabelCell>
          <FieldCell>
            <TextField
              size="small"
              label={t("vna.unc.repeatability")}
              value={us.repeatability_dB}
              onChange={(e) => set("repeatability_dB", parseInput(e.target.value))}
              slotProps={{ input: { endAdornment: <InputAdornment position="end">dB</InputAdornment> } }}
              sx={{ width: 150 }}
            />
          </FieldCell>
        </Row>

        <Alert severity="info" sx={{ mt: 1 }}>
          {t("vna.unc.desc")}
        </Alert>
      </Collapse>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Main VnaTools component
// ---------------------------------------------------------------------------
export default function VnaTools({
  calSettings,
  setCalSettings,
  peSettings,
  setPeSettings,
  deembedSettings,
  setDeembedSettings,
  tdrSettings,
  setTdrSettings,
  uncertaintySettings,
  setUncertaintySettings,
  sparamData,
  isSynthesized,
  circuitLength,
  zo,
  centerFrequency,
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState(0);
  const [expanded, setExpanded] = useState(false);

  // Summarise active features for the accordion header chip
  const activeCount = [calSettings.enabled, peSettings.enabled, deembedSettings.enabled, tdrSettings.enabled, uncertaintySettings.enabled].filter(
    Boolean,
  ).length;

  return (
    <Accordion expanded={expanded} onChange={(_, isExp) => setExpanded(isExp)} sx={{ mt: 0 }}>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Typography sx={{ fontWeight: "bold", mr: 1 }}>{t("vna.title")}</Typography>
        {activeCount > 0 && <Chip label={t("vna.activeCount", { n: activeCount })} size="small" color="primary" />}
      </AccordionSummary>
      <AccordionDetails sx={{ pt: 0 }}>
        <Tabs
          value={tab}
          onChange={(_, v) => setTab(v)}
          variant="scrollable"
          scrollButtons="auto"
          sx={{ mb: 2, borderBottom: 1, borderColor: "divider" }}
        >
          <Tab label={t("vna.tabs.calibration")} />
          <Tab label={t("vna.tabs.portExtension")} />
          <Tab label={t("vna.tabs.deembedding")} />
          <Tab label={t("vna.tabs.tdr")} />
          <Tab label={t("vna.tabs.uncertainty")} />
        </Tabs>

        {tab === 0 && <CalibrationTab calSettings={calSettings} setCalSettings={setCalSettings} circuitLength={circuitLength} />}
        {tab === 1 && <PortExtensionTab peSettings={peSettings} setPeSettings={setPeSettings} centerFrequency={centerFrequency} />}
        {tab === 2 && <DeembedTab deembedSettings={deembedSettings} setDeembedSettings={setDeembedSettings} />}
        {tab === 3 && (
          <TdrTab tdrSettings={tdrSettings} setTdrSettings={setTdrSettings} sparamData={sparamData} isSynthesized={isSynthesized} zo={zo} />
        )}
        {tab === 4 && <UncertaintyTab uncertaintySettings={uncertaintySettings} setUncertaintySettings={setUncertaintySettings} />}
      </AccordionDetails>
    </Accordion>
  );
}
