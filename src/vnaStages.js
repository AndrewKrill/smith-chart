/**
 * vnaStages.js
 * Shared definitions for the VNA correction pipeline stages.
 * Used by both VnaSmithChart and VnaTools for consistent colours and labels.
 */

export const VNA_STAGES = [
  { key: "raw",          labelKey: "vna.pipeline.stageRaw",         color: "#9E9E9E", dash: "4,4", widthPx: 1.5 },
  { key: "afterCal",     labelKey: "vna.pipeline.stageAfterCal",     color: "#FF7F0E", dash: "6,3", widthPx: 1.5 },
  { key: "afterDeembed", labelKey: "vna.pipeline.stageAfterDeembed", color: "#17BECF", dash: "6,3", widthPx: 1.5 },
  { key: "afterPe",      labelKey: "vna.pipeline.stageAfterPe",      color: "#0072B2", dash: null,  widthPx: 2   },
  { key: "afterGating",  labelKey: "vna.pipeline.stageAfterGating",  color: "#2CA02C", dash: "8,3", widthPx: 2   },
];
