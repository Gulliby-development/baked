import type { ComponentProps } from "react";
import { cn } from "../../lib/cn.js";

// A row of joined toggle buttons; the pressed one takes the accent fill.
const segmentGroupClass = "m-0 inline-flex min-w-0 flex-wrap border-0 p-0";
const segmentClass =
  "min-h-[34px] cursor-pointer border-2 border-border bg-raised px-[14px] py-0 [font-family:inherit] text-[13px] leading-[inherit] font-semibold text-soft-foreground [&+&]:border-l-0 first:rounded-l-base last:rounded-r-base aria-pressed:bg-main aria-pressed:text-main-foreground";

function SegmentGroup({ className, ...props }: ComponentProps<"fieldset">) {
  return (
    <fieldset data-slot="segment-group" className={cn(segmentGroupClass, className)} {...props} />
  );
}

function Segment({ className, type = "button", ...props }: ComponentProps<"button">) {
  return (
    <button data-slot="segment" type={type} className={cn(segmentClass, className)} {...props} />
  );
}

export { Segment, SegmentGroup, segmentClass, segmentGroupClass };
