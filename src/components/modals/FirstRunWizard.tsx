// Re-export from the wizard module — the monolith has been split into:
//   wizard/index.tsx       — orchestrator (state, keyboard, layout)
//   wizard/data.ts         — all content data
//   wizard/theme.ts        — colors and text attributes
//   wizard/primitives.tsx  — reusable row components (Gap, Hr, StepHeader, etc.)
//   wizard/ProgressBar.tsx — step progress dots
//   wizard/FooterNav.tsx   — bottom navigation bar
//   wizard/steps/          — one file per wizard step
export { FirstRunWizard } from "./wizard/index.js";
