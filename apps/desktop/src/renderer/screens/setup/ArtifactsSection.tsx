import { useState } from "react";
import {
  type Artifact,
  artifacts,
  type DeployPlan,
  type DeployTarget,
} from "../../client/artifacts.js";
import { Alert } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import { ConfirmDialog } from "../../components/ui/confirm-dialog.js";
import { Empty } from "../../components/ui/empty.js";
import { cn } from "../../lib/cn.js";
import { scrollbarTokens, withAppScrollbar } from "../../lib/frame-scrollbar.js";
import { LEDE, PANEL } from "../../lib/styles.js";
import type { SectionProps } from "../sections.js";
import {
  ACTIONS,
  errorText,
  GATE,
  GROW,
  LIST,
  LoadState,
  NOTE,
  SETUP,
  SIDE,
  SPLIT,
  SPLIT_MAIN,
  STACK,
  Tag,
  useLoad,
  WRAP,
} from "./shared.js";

const kb = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;

/** The plan in words, as the confirmation shows it. */
export function planText(plan: DeployPlan): string {
  const a = plan.artifact;
  return `"${a.title}" (${a.id} v${a.version}, ${kb(a.bytes)}) goes to the Vercel project ${plan.project} in ${plan.teamId ? `team ${plan.teamId}` : "your personal account"} as a ${plan.target} deployment. ${plan.target === "production" ? "Anyone with the link can open it." : "Only your Vercel team can open it."}`;
}

function Preview({ projectKey, artifact }: { projectKey: string; artifact: Artifact }) {
  const [page] = useLoad(
    () => artifacts.page(projectKey, artifact.id),
    ["artifact-page", projectKey, artifact.id, artifact.version],
  );
  if (page.state !== "ready") return <LoadState value={page} what="the page" />;
  // Read at each render, so a theme switch restyles the frame the next time it draws.
  const html = withAppScrollbar(page.data.html, scrollbarTokens());
  return (
    <iframe
      title={`Preview of ${artifact.title}`}
      // No same-origin: the page cannot reach this app. The app's policy keeps its scripts off;
      // Open in browser runs them.
      sandbox=""
      srcDoc={html}
      className="h-[420px] w-full rounded-base border-2 border-border bg-white"
    />
  );
}

function Details({
  projectKey,
  artifact,
  onChanged,
}: {
  projectKey: string;
  artifact: Artifact;
  onChanged: () => void;
}) {
  const [plan, setPlan] = useState<DeployPlan | null>(null);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const act = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const ask = (target: DeployTarget) =>
    act(async () => setPlan(await artifacts.plan(projectKey, artifact.id, target)));
  const last = artifact.deploys.at(-1);

  return (
    <section aria-label={`Artifact ${artifact.title}`} className={STACK}>
      <div className={ACTIONS}>
        <Button
          variant="secondary"
          size="md"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              const opened = await artifacts.open(projectKey, artifact.id);
              setNote(opened.opened ? "Opened in your browser." : `Open ${opened.path} yourself.`);
            })
          }
        >
          Open in browser
        </Button>
        <Button variant="primary" size="md" disabled={busy} onClick={() => void ask("preview")}>
          Deploy preview…
        </Button>
        <Button
          variant="secondary"
          size="md"
          disabled={busy}
          onClick={() => void ask("production")}
        >
          Deploy to production…
        </Button>
        <Button variant="secondary" size="md" disabled={busy} onClick={() => setRemoving(true)}>
          Delete…
        </Button>
      </div>
      {note && (
        <p role="status" className={NOTE}>
          {note}
        </p>
      )}
      {error && <Alert tone="error">{error}</Alert>}
      <Preview projectKey={projectKey} artifact={artifact} />
      {artifact.deploys.length > 0 && (
        <ul className={cn(PANEL, LIST, "p-0")} aria-label="Deploys">
          {[...artifact.deploys].reverse().map((d) => (
            <li key={d.id} className="flex flex-wrap gap-x-3 px-[14px] py-[9px] text-[13px]">
              <Tag>{d.target}</Tag>
              <span className="text-dim-foreground">v{d.version}</span>
              <a
                className={cn("font-mono underline", WRAP)}
                href={d.url}
                target="_blank"
                rel="noreferrer"
              >
                {d.url}
              </a>
              <span className={cn("ml-auto text-dim-foreground", NOTE)}>
                {d.at.slice(0, 16).replace("T", " ")}
              </span>
            </li>
          ))}
        </ul>
      )}
      {!last && <p className={NOTE}>Not deployed yet.</p>}
      <ConfirmDialog
        open={plan !== null}
        title={plan?.target === "production" ? "Deploy to production?" : "Deploy a preview?"}
        confirmLabel={plan?.refusal ? "Deploy" : `Deploy ${plan?.target ?? ""}`}
        busy={busy}
        error={plan?.refusal ?? error}
        onClose={() => {
          setPlan(null);
          setError(null);
        }}
        onConfirm={() => {
          if (!plan || plan.refusal) return;
          void act(async () => {
            const result = await artifacts.deploy(projectKey, artifact.id, plan.target);
            setNote(`Deployed: ${result.deployment.url}`);
            setPlan(null);
            onChanged();
          });
        }}
      >
        {plan ? planText(plan) : ""} The page is scanned for secrets before it is sent.
      </ConfirmDialog>
      <ConfirmDialog
        open={removing}
        title={`Delete ${artifact.title}?`}
        confirmLabel="Delete"
        danger
        busy={busy}
        error={error}
        onClose={() => setRemoving(false)}
        onConfirm={() =>
          void act(async () => {
            await artifacts.remove(projectKey, artifact.id);
            setRemoving(false);
            onChanged();
          })
        }
      >
        Every version of the page is removed from every project. Deployments on Vercel stay.
      </ConfirmDialog>
    </section>
  );
}

/** The HTML artifacts every project and chat shares (docs/artifacts.md). */
export function ArtifactsSection({ project }: SectionProps) {
  const [list, refresh] = useLoad(() => artifacts.list(project.key), ["artifacts", project.key]);
  const [picked, setPicked] = useState<string | null>(null);
  if (list.state !== "ready") return <LoadState value={list} what="artifacts" />;
  const items = list.data.items;
  const selected = items.find((a) => a.id === picked) ?? items[0] ?? null;
  return (
    <div className={SETUP}>
      <p className={LEDE}>
        HTML pages kept for you and shared by every project and chat. Ask any chat to save a page as
        an artifact or to deploy one; deploys go to your own Vercel account and always ask first.
      </p>
      {items.length === 0 ? (
        <Empty>
          No artifacts yet. Ask a chat to save an HTML page as an artifact, or run{" "}
          <span className="font-mono">baked artifacts save FILE</span>.
        </Empty>
      ) : (
        <div className={SPLIT}>
          <ul className={cn(PANEL, LIST, "p-0", SIDE)} aria-label="Artifacts">
            {items.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  className={GATE}
                  aria-pressed={selected?.id === a.id}
                  onClick={() => setPicked(a.id)}
                >
                  <span className={cn(GROW, STACK, "gap-1")}>
                    <span className="font-semibold">{a.title}</span>
                    <span className={cn("font-mono text-dim-foreground", NOTE)}>
                      {a.id} v{a.version} · {kb(a.bytes)}
                    </span>
                  </span>
                  {a.deploys.at(-1) && <Tag>{a.deploys.at(-1)?.target}</Tag>}
                </button>
              </li>
            ))}
          </ul>
          {selected && (
            <div className={SPLIT_MAIN}>
              <Details
                key={selected.id}
                projectKey={project.key}
                artifact={selected}
                onChanged={refresh}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
