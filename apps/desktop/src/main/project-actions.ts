import type { ApiResponse } from "../shared/api.js";
import type { ProjectAction } from "../shared/bridge.js";
import type { CliRunner } from "./baked-cli.js";

export type ApiPost = (path: string, body: unknown) => Promise<ApiResponse>;

export class ProjectActionError extends Error {}

/**
 * Pins, unpins or forgets a known folder. The project list is shared by every backend, so any
 * running one can answer; a backend without the endpoint, or no running backend at all, falls
 * back to `baked projects ACTION PATH`.
 */
export async function manageKnownProject(
  path: string,
  action: ProjectAction,
  backends: ApiPost[],
  run: CliRunner,
): Promise<"api" | "cli"> {
  for (const post of backends) {
    let result: ApiResponse;
    try {
      result = await post(`/v1/projects/${action}`, { path });
    } catch {
      continue;
    }
    if (result.status >= 200 && result.status < 300) return "api";
    const error = (result.body as { error?: { message?: string } } | null)?.error;
    // The endpoint exists and refuses the folder: the command would refuse it as well.
    if (result.status === 400 || (result.status === 404 && isKnownEndpoint(error?.message)))
      throw new ProjectActionError(error?.message ?? `Could not ${action} ${path}`);
  }
  await run(["projects", action, path]);
  return "cli";
}

/** An older backend answers an unknown path with "No endpoint PATH". */
function isKnownEndpoint(message: string | undefined): boolean {
  return message !== undefined && !message.startsWith("No endpoint");
}
