/**
 * VnaSmithChart.jsx
 *
 * A dedicated Smith chart that shows the step-by-step effect of VNA corrections.
 * Each pipeline stage (raw → after-cal → after-deembed → after-PE → after-gating)
 * is drawn as a separate coloured trace so the user can see exactly what each
 * correction does.
 */

import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import * as d3 from "d3";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import FormControlLabel from "@mui/material/FormControlLabel";
import Checkbox from "@mui/material/Checkbox";
import Stack from "@mui/material/Stack";
import Divider from "@mui/material/Divider";

import { polarToRectangular, reflToZ } from "./commonFunctions.js";
import { VNA_STAGES } from "./vnaStages.js";

// ---------------------------------------------------------------------------
// Pipeline stage colour / dash definitions — imported from shared module
// ---------------------------------------------------------------------------
// (STAGES is the same as VNA_STAGES; local alias for readability)
const STAGES = VNA_STAGES;

// ---------------------------------------------------------------------------
// Coordinate helpers (duplicated from Graph.jsx — pure math, no side effects)
// ---------------------------------------------------------------------------

function impedanceToSmithCoordinates(re, im) {
  const a = 1 / (1 + re);
  const b = 1 / im;
  if (im === 0) return [-2 * a, 0];
  const x = (-2 * a * b * b) / (a * a + b * b);
  const y = (2 * a * a * b) / (a * a + b * b);
  return [x, -y];
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

function initializeSmithChart(tracingArcsRef, width, rCircles, xCircles) {
  const tracingArcs = d3.select(tracingArcsRef.current).attr("stroke", "rgba(0,0,0,0.6)").attr("fill", "none").attr("stroke-width", 0.8);
  tracingArcs.selectAll("*").remove();

  rCircles.forEach((r) => {
    const [cx, , radius] = resistanceToXYR(r);
    tracingArcs.append("circle").attr("cx", cx * width * 0.5).attr("cy", 0).attr("r", radius * width * 0.5);
  });

  xCircles.forEach((r, i) => {
    const [cy, xStart, yStart, xEnd, yEnd] = reactanceToXYR(r);
    let xs = i % 2 === 1 ? 0 : xStart;
    let ys = i % 2 === 1 ? 0 : yStart;
    const cw = cy < 0 ? 1 : 0;
    tracingArcs.append("path").attr(
      "d",
      `M ${xs * width * 0.5} ${ys * width * 0.5} A ${cy * width * 0.5} ${cy * width * 0.5} 0 0 ${cw} ${xEnd * width * 0.5} ${yEnd * width * 0.5}`,
    );
  });

  tracingArcs.append("line").attr("x1", 0).attr("y1", 0).attr("x2", -width).attr("y2", 0);
}

// ---------------------------------------------------------------------------
// Default Smith chart grid circles (constant, defined outside component)
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
}) {
  const { t } = useTranslation();
  const svgRef = useRef(null);
  const svgWrapper = useRef(null);
  const topGroupRef = useRef(null);
  const tracingArcsRef = useRef(null);
  const tracesRef = useRef(null);

  const [width, setWidth] = useState(500);

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
    initializeSmithChart(tracingArcsRef, width, DEFAULT_R_CIRCLES, DEFAULT_X_CIRCLES);
  }, [width]);

  // -------------------------------------------------------------------------
  // Draw correction-stage traces
  // -------------------------------------------------------------------------
  useEffect(() => {
    const svg = d3.select(tracesRef.current);
    svg.selectAll("*").remove();
    if (!intermediateTraces || !visibleStages) return;

    const refZo = sParamZo || zo;

    for (const stage of STAGES) {
      if (!visibleStages[stage.key]) continue;
      const data = intermediateTraces[stage.key];
      if (!data) continue;

      const coord = [];

      if (stage.key === "afterGating") {
        // Gated data uses a different format: { gatedFdMag, gatedFdPhase, freqAxis }
        const { gatedFdMag, gatedFdPhase, freqAxis } = data;
        if (!freqAxis || freqAxis.length === 0) continue;
        for (let k = 0; k < freqAxis.length; k++) {
          const rect = polarToRectangular({ magnitude: gatedFdMag[k], angle: gatedFdPhase[k] });
          const z = reflToZ(rect, refZo);
          coord.push(impedanceToSmithChart(z.real / zo, z.imaginary / zo, width));
        }
      } else {
        // Standard format: { freq: { S11: { magnitude, angle } } }
        for (const fStr in data) {
          const point = data[fStr];
          if (!point || !point.S11) continue;
          const rect = polarToRectangular(point.S11);
          const z = reflToZ(rect, refZo);
          coord.push(impedanceToSmithChart(z.real / zo, z.imaginary / zo, width));
        }
      }

      if (coord.length < 2) continue;

      const pathStr = `M ${coord[0][0]} ${coord[0][1]} ${coord.map((c) => `L ${c[0]} ${c[1]}`).join(" ")}`;
      const pathEl = svg
        .append("path")
        .attr("stroke-linecap", "round")
        .attr("stroke-linejoin", "round")
        .attr("fill", "none")
        .attr("stroke", stage.color)
        .attr("stroke-width", stage.widthPx)
        .attr("d", pathStr);

      if (stage.dash) {
        pathEl.attr("stroke-dasharray", stage.dash);
      }

      // Endpoint dot marker
      const last = coord[coord.length - 1];
      svg.append("circle").attr("cx", last[0]).attr("cy", last[1]).attr("r", 4).attr("fill", stage.color).attr("stroke", "none");
    }
  }, [zo, sParamZo, width, intermediateTraces, visibleStages]);

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
    <Box sx={{ display: "flex", flexDirection: "column", width: "100%", minWidth: 0 }}>
      <Typography variant="subtitle2" sx={{ px: 1, pt: 0.5, fontWeight: "bold" }}>
        {t("vna.pipeline.correctedChartTitle")}
      </Typography>

      <Box sx={{ position: "relative", width: "100%", minWidth: 0 }}>
        <div ref={svgWrapper} style={{ textAlign: "center" }}>
          <svg ref={svgRef} style={{ margin: "8px" }}>
            <g ref={topGroupRef}>
              <g ref={tracingArcsRef} />
              <g ref={tracesRef} />
            </g>
          </svg>
        </div>
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
  );
}
