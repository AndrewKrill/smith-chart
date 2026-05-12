/**
 * VnaSmithChart.jsx
 *
 * A dedicated Smith chart that shows the step-by-step effect of VNA corrections.
 * Each pipeline stage (raw → after-cal → after-deembed → after-PE → after-gating)
 * is drawn as a separate coloured trace so the user can see exactly what each
 * correction does.
 *
 * Features:
 *   - DP0 (black-box target) reference marker
 *   - Interactive hover tooltip (frequency, impedance, VSWR, reflection coefficient, etc.)
 *   - Graph settings dialog (resistance/reactance circles, admittance overlay)
 */

import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import * as d3 from "d3";
import { styled } from "@mui/material/styles";
import Tooltip, { tooltipClasses } from "@mui/material/Tooltip";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import FormControlLabel from "@mui/material/FormControlLabel";
import Checkbox from "@mui/material/Checkbox";
import Stack from "@mui/material/Stack";
import Divider from "@mui/material/Divider";
import Link from "@mui/material/Link";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import TextField from "@mui/material/TextField";
import FormControl from "@mui/material/FormControl";

import { polarToRectangular, reflToZ, processImpedance, parseInput, unitConverter } from "./commonFunctions.js";
import { VNA_STAGES } from "./vnaStages.js";

// ---------------------------------------------------------------------------
// Pipeline stage colour / dash definitions — imported from shared module
// ---------------------------------------------------------------------------
const STAGES = VNA_STAGES;

// Snap-point hit radius in pixels
const SNAP_RADIUS = 5;

// ---------------------------------------------------------------------------
// Coordinate helpers (pure math, no side effects)
// ---------------------------------------------------------------------------

function impedanceToSmithCoordinates(re, im) {
  const a = 1 / (1 + re);
  const b = 1 / im;
  if (im === 0) return [-2 * a, 0];
  const x = (-2 * a * b * b) / (a * a + b * b);
  const y = (2 * a * a * b) / (a * a + b * b);
  return [x, -y];
}

function smithCoordinatesToImpedance(x, y) {
  const a = -(y * y + x * x) / (2 * x);
  const b = (y * y + x * x) / (2 * y);
  const re = 1 / a - 1;
  const im = -1 / b;
  return [re, im];
}

function impedanceToSmithChart(re, im, width) {
  const [x, y] = impedanceToSmithCoordinates(re, im);
  return [Number((x * width * 0.5).toFixed(1)), Number((y * width * 0.5).toFixed(1))];
}

function resistanceToXYR(z) {
  const [x] = impedanceToSmithCoordinates(z, 0);
  return [x / 2, 0, -x / 2];
}

function reactanceToXYR(z) {
  const zn = -z;
  const cy = 1 / zn;
  const xEnd = -2 / (zn * zn + 1);
  const yEnd = (2 * zn) / (zn * zn + 1);
  const a = -1 / (1 + 10);
  const xStart = (2 * a) / (zn * zn * a * a + 1);
  const yStart = zn * a * xStart;
  return [cy, xStart, yStart, xEnd, yEnd];
}

// ---------------------------------------------------------------------------
// Smith chart grid (supports admittance overlay and custom circles)
// ---------------------------------------------------------------------------

function initializeSmithChart(tracingArcsRef, width, rCircles, xCircles, showAdmittance) {
  const tracingArcs = d3.select(tracingArcsRef.current).attr("stroke", "rgba(0,0,0,0.6)").attr("fill", "none").attr("stroke-width", 0.8);
  tracingArcs.selectAll("*").remove();

  rCircles.forEach((r) => {
    const [cx, , radius] = resistanceToXYR(r);
    tracingArcs.append("circle").attr("cx", cx * width * 0.5).attr("cy", 0).attr("r", radius * width * 0.5);
  });

  xCircles.forEach((r, i) => {
    const [cy, xStart, yStart, xEnd, yEnd] = reactanceToXYR(r);
    const xs = i % 2 === 1 ? 0 : xStart;
    const ys = i % 2 === 1 ? 0 : yStart;
    const cw = cy < 0 ? 1 : 0;
    tracingArcs.append("path").attr(
      "d",
      `M ${xs * width * 0.5} ${ys * width * 0.5} A ${cy * width * 0.5} ${cy * width * 0.5} 0 0 ${cw} ${xEnd * width * 0.5} ${yEnd * width * 0.5}`,
    );
  });

  if (showAdmittance) {
    rCircles.forEach((r) => {
      const [cx, , radius] = resistanceToXYR(r);
      tracingArcs
        .append("circle")
        .attr("cx", (-2 - cx) * width * 0.5)
        .attr("cy", 0)
        .attr("r", radius * width * 0.5)
        .attr("stroke", "rgba(0,0,0,0.25)");
    });
    xCircles.forEach((r, i) => {
      const [cy, xStart, yStart, xEnd, yEnd] = reactanceToXYR(r);
      const xs = i % 2 === 1 ? 0 : xStart;
      const ys = i % 2 === 1 ? 0 : yStart;
      const cw = cy < 0 ? 0 : 1;
      tracingArcs
        .append("path")
        .attr(
          "d",
          `M ${(-2 - xs) * width * 0.5} ${ys * width * 0.5} A ${cy * width * 0.5} ${cy * width * 0.5} 0 0 ${cw} ${(-2 - xEnd) * width * 0.5} ${yEnd * width * 0.5}`,
        )
        .attr("stroke", "rgba(0,0,0,0.25)");
    });
  }

  tracingArcs.append("line").attr("x1", 0).attr("y1", 0).attr("x2", -width).attr("y2", 0);
}

// ---------------------------------------------------------------------------
// Hover tooltip (mirrors Graph.jsx HoverTooltip)
// ---------------------------------------------------------------------------

function HoverTooltip({ z, frequency, zo, freqUnit }) {
  const { t } = useTranslation();
  if (z.real < 0) return <p>{t("graph.hoverOutside")}</p>;
  const res = processImpedance(z, zo);
  const fUnit = freqUnit || "MHz";
  return (
    <>
      {frequency !== null && frequency !== undefined && (
        <p style={{ margin: 0, padding: 0 }}>{t("graph.frequency", { v: (frequency / (unitConverter[fUnit] || 1e6)).toPrecision(6), unit: fUnit })}</p>
      )}
      <p style={{ margin: 0, padding: 0 }}>{t("graph.impedance", { z: res.zStr, polar: res.zPolarStr })}</p>
      <p style={{ margin: 0, padding: 0 }}>{t("graph.admittance", { v: res.admString })}</p>
      <p style={{ margin: 0, padding: 0 }}>{t("graph.reflCoeff", { v: res.refStr, polar: res.refPolarStr })}</p>
      <p style={{ margin: 0, padding: 0 }}>{t("graph.vswr", { v: res.vswr })}</p>
      <p style={{ margin: 0, padding: 0 }}>{t("graph.qFactorHover", { v: res.qFactor })}</p>
    </>
  );
}

const LightTooltip = styled(({ className, ...props }) => (
  <Tooltip
    {...props}
    classes={{ popper: className }}
    slotProps={{
      popper: {
        modifiers: [{ name: "offset", options: { offset: [0, 0] } }],
      },
    }}
  />
))(({ theme }) => ({
  [`& .${tooltipClasses.tooltip}`]: {
    backgroundColor: theme.palette.common.black,
    color: "white",
    boxShadow: theme.shadows[1],
    fontSize: "0.8rem",
  },
}));

// ---------------------------------------------------------------------------
// Graph settings dialog (same pattern as Graph.jsx DialogGraphSettings)
// ---------------------------------------------------------------------------

function DialogGraphSettings({ dialogOpen, setDialogOpen, resistanceCircles, setResistanceCircles, reactanceCircles, setReactanceCircles, showAdmittance, setShowAdmittance }) {
  const { t } = useTranslation();
  const [tempRCircles, setTempRCircles] = useState(resistanceCircles.join(", "));
  const [tempReacCircles, setTempReacCircles] = useState(reactanceCircles.join(", "));

  function handleClose() {
    setDialogOpen(false);
    setResistanceCircles(tempRCircles ? tempRCircles.split(",").map((x) => parseFloat(parseInput(x))).filter((v) => !isNaN(v)) : []);
    setReactanceCircles(tempReacCircles ? tempReacCircles.split(",").map((x) => parseFloat(parseInput(x))).filter((v) => !isNaN(v)) : []);
  }

  return (
    <Dialog onClose={handleClose} open={dialogOpen} maxWidth="xl" fullWidth>
      <DialogTitle>{t("graph.dialogTitle")}</DialogTitle>
      <DialogContent>
        <FormControl sx={{ minWidth: 250 }} fullWidth>
          <TextField
            sx={{ mt: 2, minWidth: 250 }}
            label={t("graph.resistanceCircles")}
            variant="outlined"
            size="small"
            value={tempRCircles}
            onChange={(e) => setTempRCircles(e.target.value)}
          />
          <TextField
            sx={{ mt: 2 }}
            label={t("graph.reactanceCircles")}
            variant="outlined"
            size="small"
            value={tempReacCircles}
            onChange={(e) => setTempReacCircles(e.target.value)}
          />
          <FormControlLabel
            control={<Checkbox checked={showAdmittance} onChange={(e) => setShowAdmittance(e.target.checked)} />}
            label={t("graph.showAdmittance")}
          />
        </FormControl>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Default Smith chart grid circles (same as primary chart)
// ---------------------------------------------------------------------------
const DEFAULT_R_CIRCLES = [0, 0.2, 0.5, 1, 2, 4, 10];
const DEFAULT_X_CIRCLES = [0.2, 0.5, 1, 2, 4, 10, -0.2, -0.5, -1, -2, -4, -10];

export default function VnaSmithChart({
  zo,
  sParamZo,            // zo of the loaded S-param file (for reflToZ)
  intermediateTraces,  // { raw, afterCal, afterDeembed, afterPe, afterGating }
  visibleStages,       // { raw, afterCal, afterDeembed, afterPe, afterGating }
  setVisibleStages,    // setter for visibleStages
  activeStages,        // { cal, deembed, pe, gating } — which corrections are currently enabled
  dp0Impedance,        // { real, imaginary } — black-box target impedance (Ω) for DP0 marker
  freqUnit,            // frequency unit string ("MHz", "GHz", …) for hover tooltip
}) {
  const { t } = useTranslation();
  const svgRef = useRef(null);
  const svgWrapper = useRef(null);
  const topGroupRef = useRef(null);
  const tracingArcsRef = useRef(null);
  const tracesRef = useRef(null);
  const dp0Ref = useRef(null);
  const hoverRectsRef = useRef(null);

  const [width, setWidth] = useState(500);
  const [hoverImpedance, setHoverImpedance] = useState([0, 0, null]);
  const [hSnaps, setHSnaps] = useState([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [resistanceCircles, setResistanceCircles] = useState(DEFAULT_R_CIRCLES);
  const [reactanceCircles, setReactanceCircles] = useState(DEFAULT_X_CIRCLES);
  const [showAdmittance, setShowAdmittance] = useState(false);

  // -------------------------------------------------------------------------
  // Responsive width
  // -------------------------------------------------------------------------
  useEffect(() => {
    function handleResize() {
      if (!svgWrapper.current) return;
      const w = svgWrapper.current.offsetWidth;
      if (w > 700) setWidth(650);
      else if (w > 600) setWidth(550);
      else if (w > 460) setWidth(450);
      else setWidth(350);
    }
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // -------------------------------------------------------------------------
  // Draw Smith chart grid
  // -------------------------------------------------------------------------
  useEffect(() => {
    d3.select(svgRef.current).attr("width", width).attr("height", width);
    d3.select(topGroupRef.current)
      .attr("transform", `translate(${width}, ${0.5 * width})`)
      .attr("fill", "none")
      .attr("stroke", "black")
      .attr("stroke-width", 1);
    initializeSmithChart(tracingArcsRef, width, resistanceCircles, reactanceCircles, showAdmittance);
  }, [width, resistanceCircles, reactanceCircles, showAdmittance]);

  // -------------------------------------------------------------------------
  // Draw correction-stage traces + collect hover snap points
  // -------------------------------------------------------------------------
  useEffect(() => {
    const svg = d3.select(tracesRef.current);
    svg.selectAll("*").remove();
    if (!intermediateTraces || !visibleStages) {
      setHSnaps([]);
      return;
    }

    const refZo = sParamZo || zo;
    const snaps = [];

    for (const stage of STAGES) {
      if (!visibleStages[stage.key]) continue;
      const data = intermediateTraces[stage.key];
      if (!data) continue;

      const coord = [];
      const freqPoints = [];

      // All stages use standard frequency-keyed format: { "Hz": { S11: { magnitude, angle } } }
      for (const fStr in data) {
        const point = data[fStr];
        if (!point || !point.S11) continue;
        const rect = polarToRectangular(point.S11);
        const z = reflToZ(rect, refZo);
        coord.push(impedanceToSmithChart(z.real / zo, z.imaginary / zo, width));
        freqPoints.push({ fStr, zReal: z.real, zImag: z.imaginary });
      }

      if (coord.length < 2) continue;

      // Trace path
      const pathStr = `M ${coord[0][0]} ${coord[0][1]} ${coord.map((c) => `L ${c[0]} ${c[1]}`).join(" ")}`;
      const pathEl = svg
        .append("path")
        .attr("stroke-linecap", "round")
        .attr("stroke-linejoin", "round")
        .attr("fill", "none")
        .attr("stroke", stage.color)
        .attr("stroke-width", stage.widthPx)
        .attr("d", pathStr);
      if (stage.dash) pathEl.attr("stroke-dasharray", stage.dash);

      // Small frequency-point dots for hover snapping
      coord.forEach(([cx, cy], idx) => {
        svg
          .append("circle")
          .attr("cx", cx)
          .attr("cy", cy)
          .attr("r", SNAP_RADIUS)
          .attr("fill", stage.color)
          .attr("opacity", 0.3)
          .attr("stroke", "none");
        snaps.push({
          x: cx - SNAP_RADIUS,
          y: cy - SNAP_RADIUS,
          real: freqPoints[idx].zReal,
          imaginary: freqPoints[idx].zImag,
          frequency: Number(freqPoints[idx].fStr),
        });
      });

      // Endpoint dot (larger, opaque)
      const last = coord[coord.length - 1];
      svg.append("circle").attr("cx", last[0]).attr("cy", last[1]).attr("r", 4).attr("fill", stage.color).attr("stroke", "none");
    }

    setHSnaps(snaps);
  }, [zo, sParamZo, width, intermediateTraces, visibleStages]);

  // -------------------------------------------------------------------------
  // Draw DP0 (black-box target) marker
  // -------------------------------------------------------------------------
  useEffect(() => {
    const svg = d3.select(dp0Ref.current);
    svg.selectAll("*").remove();
    if (!dp0Impedance) return;

    const r = parseFloat(dp0Impedance.real);
    const im = parseFloat(dp0Impedance.imaginary);
    if (isNaN(r) || r < 0) return;

    const [cx, cy] = impedanceToSmithChart(r / zo, im / zo, width);
    const DP0_R = 7;

    // White halo
    svg.append("circle").attr("cx", cx).attr("cy", cy).attr("r", DP0_R + 2).attr("fill", "white").attr("stroke", "none");
    // Filled marker
    svg.append("circle").attr("cx", cx).attr("cy", cy).attr("r", DP0_R).attr("fill", "#d62728").attr("stroke", "#7f1010").attr("stroke-width", 1.5);
    // Label "DP0" — 5 chars × ~8 px/char average width
    const strLen = 5 * 8;
    svg
      .append("rect")
      .attr("x", cx - strLen / 2)
      .attr("y", cy - DP0_R - 16)
      .attr("width", strLen)
      .attr("height", 13)
      .attr("fill", "white")
      .attr("stroke", "none")
      .attr("opacity", 0.85);
    svg
      .append("text")
      .attr("x", cx)
      .attr("y", cy - DP0_R - 5)
      .text("DP0")
      .attr("font-size", "11px")
      .attr("font-weight", "bold")
      .attr("text-anchor", "middle")
      .attr("fill", "#d62728")
      .attr("stroke", "none");
  }, [dp0Impedance, zo, width]);

  // -------------------------------------------------------------------------
  // Mouse handlers (hover tooltip + indicator circles)
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (zo <= 0) return;
    const svg = d3.select(svgRef.current);
    const svgGroup = d3.select(topGroupRef.current);

    svg.on("mousemove", null);
    svg.on("mouseleave", null);

    svg.on("mousemove", (event) => {
      const hoverRects = d3.select(hoverRectsRef.current);
      hoverRects.selectAll("*").remove();

      const [mouseX, mouseY] = d3.pointer(event, svgGroup.node());
      const x = mouseX / (0.5 * width);
      const y = mouseY / (0.5 * width);

      let re, im, frequency = null, snapped = false;

      for (const s of hSnaps) {
        if (mouseX > s.x && mouseX < s.x + 2 * SNAP_RADIUS && mouseY > s.y && mouseY < s.y + 2 * SNAP_RADIUS) {
          re = s.real / zo;
          im = s.imaginary / zo;
          frequency = s.frequency;
          hoverRects
            .append("rect")
            .attr("x", s.x)
            .attr("y", s.y)
            .attr("width", 2 * SNAP_RADIUS)
            .attr("height", 2 * SNAP_RADIUS)
            .attr("stroke", "red")
            .attr("stroke-width", 2)
            .attr("fill", "none");
          snapped = true;
          break;
        }
      }

      if (!snapped) {
        [re, im] = smithCoordinatesToImpedance(x, y);
      }

      setHoverImpedance([re, im, frequency]);

      // Constant-resistance circle
      let hoverReal = svgGroup.select("#vna_hover_real");
      let hoverImaginary = svgGroup.select("#vna_hover_imag");
      if (hoverReal.empty())
        svgGroup.append("circle").attr("id", "vna_hover_real").attr("stroke-dasharray", "5,5").attr("stroke", "rgba(0,0,0,0.5)").attr("fill", "none");
      if (hoverImaginary.empty())
        svgGroup.append("path").attr("id", "vna_hover_imag").attr("stroke-dasharray", "5,5").attr("stroke", "rgba(0,0,0,0.5)").attr("fill", "none");

      if (re > 0) {
        const [cx, , r] = resistanceToXYR(re);
        svgGroup.select("#vna_hover_real").attr("cx", cx * width * 0.5).attr("cy", 0).attr("r", r * width * 0.5);
        const [cy, , , xEnd, yEnd] = reactanceToXYR(im);
        if (im === 0) {
          svgGroup.select("#vna_hover_imag").attr("d", `M 0 0 L ${-2 * width * 0.5} 0`);
        } else {
          const cw = cy < 0 ? 1 : 0;
          svgGroup
            .select("#vna_hover_imag")
            .attr("d", `M 0 0 A ${cy * width * 0.5} ${cy * width * 0.5} 0 0 ${cw} ${xEnd * width * 0.5} ${yEnd * width * 0.5}`);
        }
      } else {
        svgGroup.select("#vna_hover_real").remove();
        svgGroup.select("#vna_hover_imag").remove();
      }
    });

    svg.on("mouseleave", () => {
      svgGroup.select("#vna_hover_real").remove();
      svgGroup.select("#vna_hover_imag").remove();
      d3.select(hoverRectsRef.current).selectAll("*").remove();
    });

    return () => {
      svg.on("mousemove", null);
      svg.on("mouseleave", null);
    };
  }, [hSnaps, width, zo]);

  // -------------------------------------------------------------------------
  // Determine which stages are relevant (have data + are active)
  // -------------------------------------------------------------------------
  const relevantStages = STAGES.filter(({ key }) => {
    if (!intermediateTraces?.[key]) return false;
    if (key === "raw") return true;
    if (key === "afterCal") return activeStages?.cal;
    if (key === "afterDeembed") return activeStages?.deembed;
    if (key === "afterPe") return activeStages?.pe;
    if (key === "afterGating") return activeStages?.gating;
    return false;
  });

  if (relevantStages.length === 0) return null;

  return (
    <>
      <DialogGraphSettings
        dialogOpen={dialogOpen}
        setDialogOpen={setDialogOpen}
        resistanceCircles={resistanceCircles}
        setResistanceCircles={setResistanceCircles}
        reactanceCircles={reactanceCircles}
        setReactanceCircles={setReactanceCircles}
        showAdmittance={showAdmittance}
        setShowAdmittance={setShowAdmittance}
      />
      <Box sx={{ display: "flex", flexDirection: "column", width: "100%", minWidth: 0 }}>
        <Typography variant="subtitle2" sx={{ px: 1, pt: 0.5, fontWeight: "bold" }}>
          {t("vna.pipeline.correctedChartTitle")}
        </Typography>

        <Box sx={{ position: "relative", width: "100%", minWidth: 0 }}>
          <Link
            component="button"
            variant="caption"
            underline="hover"
            onClick={() => setDialogOpen(true)}
            sx={{ position: "absolute", bottom: 0, right: 4 }}
          >
            {t("graph.graphSettings")}
          </Link>
          <LightTooltip
            title={
              <HoverTooltip
                z={{ real: hoverImpedance[0] * zo, imaginary: hoverImpedance[1] * zo }}
                frequency={hoverImpedance[2]}
                freqUnit={freqUnit || "MHz"}
                zo={zo}
              />
            }
            followCursor
            sx={{ maxWidth: 300 }}
            enterTouchDelay={0}
            leaveTouchDelay={10000}
          >
            <div ref={svgWrapper} style={{ textAlign: "center" }}>
              <svg ref={svgRef} style={{ margin: "8px" }}>
                <g ref={topGroupRef}>
                  <g ref={tracingArcsRef} />
                  <g ref={tracesRef} />
                  <g ref={dp0Ref} />
                  <g ref={hoverRectsRef} />
                </g>
              </svg>
            </div>
          </LightTooltip>
        </Box>

        {/* Legend + visibility toggles */}
        <Divider />
        <Stack direction="row" flexWrap="wrap" spacing={0} useFlexGap sx={{ px: 1, py: 0.5 }}>
          {relevantStages.map((stage) => (
            <FormControlLabel
              key={stage.key}
              control={
                <Checkbox
                  size="small"
                  checked={visibleStages[stage.key]}
                  onChange={(e) => setVisibleStages((s) => ({ ...s, [stage.key]: e.target.checked }))}
                  sx={{ color: stage.color, "&.Mui-checked": { color: stage.color } }}
                />
              }
              label={
                <Typography variant="caption" sx={{ color: stage.color, fontWeight: "bold" }}>
                  {t(stage.labelKey)}
                </Typography>
              }
            />
          ))}
        </Stack>
      </Box>
    </>
  );
}
