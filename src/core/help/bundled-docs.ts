/**
 * BAKED's own documentation, bundled into every build (`bun build --compile` included) so the agent
 * can answer questions about BAKED in any project. Add a line here for each new page in `docs/`;
 * `tests/docs.test.ts` fails when a page is missing.
 */

import architectureMd from "../../../docs/architecture.md" with { type: "text" };
import artifactsMd from "../../../docs/artifacts.md" with { type: "text" };
import benchLoopMd from "../../../docs/bench-loop.md" with { type: "text" };
import brandMd from "../../../docs/brand.md" with { type: "text" };
import commandsMd from "../../../docs/commands.md" with { type: "text" };
import configurationMd from "../../../docs/configuration.md" with { type: "text" };
import coordinatorMd from "../../../docs/coordinator.md" with { type: "text" };
import customCommandsMd from "../../../docs/custom-commands.md" with { type: "text" };
import desktopApiMd from "../../../docs/desktop/api.md" with { type: "text" };
import desktopAppMd from "../../../docs/desktop/app.md" with { type: "text" };
import extensionsMd from "../../../docs/extensions.md" with { type: "text" };
import gettingStartedMd from "../../../docs/getting-started.md" with { type: "text" };
import guideMd from "../../../docs/guide.md" with { type: "text" };
import headlessMd from "../../../docs/headless.md" with { type: "text" };
import parityMd from "../../../docs/parity.md" with { type: "text" };
import privacyMd from "../../../docs/privacy.md" with { type: "text" };
import projectsMd from "../../../docs/projects.md" with { type: "text" };
import providersMd from "../../../docs/providers.md" with { type: "text" };
import readmeMd from "../../../docs/README.md" with { type: "text" };
import sandboxMd from "../../../docs/sandbox.md" with { type: "text" };
import toolsMd from "../../../docs/tools.md" with { type: "text" };
import troubleshootingMd from "../../../docs/troubleshooting.md" with { type: "text" };
import watchMd from "../../../docs/watch.md" with { type: "text" };
import workflowsArchitectureMd from "../../../docs/workflows/architecture.md" with { type: "text" };
import workflowsDoctorAndEstimateMd from "../../../docs/workflows/doctor-and-estimate.md" with {
  type: "text",
};
import workflowsFixCiMd from "../../../docs/workflows/fix-ci.md" with { type: "text" };
import workflowsParallelWorktreesMd from "../../../docs/workflows/parallel-worktrees.md" with {
  type: "text",
};
import workflowsQuickMd from "../../../docs/workflows/quick.md" with { type: "text" };
import workflowsReadmeMd from "../../../docs/workflows/README.md" with { type: "text" };
import workflowsRuntimeMd from "../../../docs/workflows/runtime.md" with { type: "text" };
import workflowsV2DesignMd from "../../../docs/workflows/v2-design.md" with { type: "text" };

export const BUNDLED_DOCS: ReadonlyArray<readonly [path: string, text: string]> = [
  ["README.md", readmeMd],
  ["architecture.md", architectureMd],
  ["artifacts.md", artifactsMd],
  ["bench-loop.md", benchLoopMd],
  ["brand.md", brandMd],
  ["commands.md", commandsMd],
  ["configuration.md", configurationMd],
  ["coordinator.md", coordinatorMd],
  ["custom-commands.md", customCommandsMd],
  ["desktop/api.md", desktopApiMd],
  ["desktop/app.md", desktopAppMd],
  ["extensions.md", extensionsMd],
  ["getting-started.md", gettingStartedMd],
  ["guide.md", guideMd],
  ["headless.md", headlessMd],
  ["parity.md", parityMd],
  ["privacy.md", privacyMd],
  ["projects.md", projectsMd],
  ["sandbox.md", sandboxMd],
  ["providers.md", providersMd],
  ["tools.md", toolsMd],
  ["troubleshooting.md", troubleshootingMd],
  ["watch.md", watchMd],
  ["workflows/README.md", workflowsReadmeMd],
  ["workflows/architecture.md", workflowsArchitectureMd],
  ["workflows/doctor-and-estimate.md", workflowsDoctorAndEstimateMd],
  ["workflows/fix-ci.md", workflowsFixCiMd],
  ["workflows/parallel-worktrees.md", workflowsParallelWorktreesMd],
  ["workflows/quick.md", workflowsQuickMd],
  ["workflows/runtime.md", workflowsRuntimeMd],
  ["workflows/v2-design.md", workflowsV2DesignMd],
];
