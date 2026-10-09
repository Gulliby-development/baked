import { memo } from "react";
import { icon } from "../../../../core/icons.js";
import { MODE_ITEMS } from "../data.js";
import { FeatureList } from "../primitives.js";

export const ModesStep = memo(function ModesStep() {
  return (
    <FeatureList
      heading="Modes — how Baked approaches work"
      headerIcon={icon("plan")}
      intro="Cycle with Ctrl+D. Auto runs hands-free. Plan is research-only. Architect is a read-only design mode."
      items={MODE_ITEMS.map((x) => ({ ...x, ic: icon(x.ic) }))}
    />
  );
});
