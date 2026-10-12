import { attentionItemId } from "../../../shared/attention.js";
import {
  attentionApi,
  type DeliveryBody,
  deliveryFile,
  exclusionReason,
  parseBody,
} from "../../client/attention.js";
import { Button } from "../../components/ui/button.js";
import { cn } from "../../lib/cn.js";
import { LABEL } from "../../lib/styles.js";
import { projectHref } from "../../router.js";
import {
  ACTIONS,
  ActionError,
  ASIDE,
  BTN,
  DetailHeader,
  FACTS,
  Fact,
  LEDE,
  LINK_BTN,
  LIST,
  Loading,
  NOTE,
  RejectForm,
  ROW,
  useAction,
  useLoad,
} from "./common.js";
import { type DetailProps, Gone } from "./RunDetails.js";

const OPERATION: Record<string, string> = {
  commit: "commit",
  push: "push",
  pull_request: "pull request",
};

export function operationsLine(operations: string[] | undefined): string {
  return (operations ?? []).map((o) => OPERATION[o] ?? o).join(", ");
}

export function DeliveryDetail({ item, onDone }: DetailProps) {
  const runId = item.runId ?? "";
  const [load] = useLoad(
    () => attentionApi.run(item.projectKey, runId),
    [item.projectKey, "attention-run", runId, item.requestId],
  );
  const action = useAction();
  return (
    <Loading load={load}>
      {(run) => {
        const request = run.requests.find((r) => r.id === item.requestId);
        if (!request) return <Gone item={item} />;
        const plan = parseBody<DeliveryBody>(request);
        const pr = plan.pullRequest ?? null;
        return (
          <>
            <DetailHeader
              item={item}
              aside={<span className={ASIDE}>{operationsLine(plan.operations)}</span>}
            />
            <p className={LEDE}>
              Nothing in Git changes until you approve this exact plan. Your other uncommitted files
              stay as they are.
            </p>
            <div className={FACTS}>
              <Fact label="Branch">
                <span className="font-mono">{plan.branch ?? "–"}</span>
              </Fact>
              <Fact label="Remote">
                <span className="font-mono">
                  {plan.remote?.name ?? "–"} → {plan.base?.branch ?? "–"}
                </span>
              </Fact>
              <Fact label="Pull request">
                {pr ? (pr.draft ? "Draft" : "Ready for review") : "None"}
              </Fact>
            </div>
            <section className={LIST} aria-label="Files in the commit">
              <span className={LABEL}>Files in the commit</span>
              {(plan.files ?? []).map((line) => {
                const file = deliveryFile(line);
                return (
                  <div key={line} className={ROW}>
                    <span className="font-mono">{file.path}</span>
                    <span className="text-dim-foreground">{file.action}</span>
                  </div>
                );
              })}
              {(plan.excluded ?? []).map((excluded) => (
                <div key={excluded.path} className={cn(ROW, "text-dim-foreground")}>
                  <span className="font-mono">{excluded.path}</span>
                  <span>{exclusionReason(excluded.reason)}</span>
                </div>
              ))}
            </section>
            {plan.userChanges?.length ? (
              <p className={NOTE}>
                Left untouched: {plan.userChanges.length} other uncommitted{" "}
                {plan.userChanges.length === 1 ? "file" : "files"} (
                <span className="font-mono">{plan.userChanges.slice(0, 3).join(", ")}</span>
                {plan.userChanges.length > 3 ? ", …" : ""}).
              </p>
            ) : null}
            <section className={LIST} aria-label="Commit message">
              <span className={LABEL}>Commit message</span>
              <span className="whitespace-pre-wrap text-[13px] text-soft-foreground">
                {plan.commitMessage ?? "–"}
              </span>
              {pr && pr.title !== plan.commitMessage && (
                <span className="text-dim-foreground">
                  Pull request: {pr.title} ({pr.repository})
                </span>
              )}
            </section>
            <ActionError error={action.error} />
            <div className={ACTIONS}>
              <Button
                variant="primary"
                size="md"
                className={BTN}
                disabled={action.busy}
                onClick={() =>
                  void action.run(async () => {
                    const result = await attentionApi.deliver(item.projectKey, runId, request);
                    const link = result.pullRequest?.url
                      ? ` Pull request: ${result.pullRequest.url}`
                      : "";
                    onDone(`Delivered ${item.featureId} on ${result.branch}.${link}`);
                  })
                }
              >
                Approve and deliver
              </Button>
              {pr && (
                <Button
                  variant="secondary"
                  size="md"
                  className={BTN}
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(async () => {
                      const prepared = await attentionApi.prepareDelivery(item.projectKey, runId, {
                        pullRequest: false,
                        ...(plan.remote ? { remote: plan.remote.name } : {}),
                      });
                      onDone(
                        "A new plan without a pull request replaces this one. Review it before you approve.",
                        attentionItemId({ ...item, requestId: prepared.requestId }),
                      );
                    })
                  }
                >
                  Commit only, no PR
                </Button>
              )}
              <RejectForm
                busy={action.busy}
                onReject={(reason) =>
                  void action.run(async () => {
                    await attentionApi.reject(item.projectKey, runId, request.id, reason);
                    onDone(`Rejected the delivery of ${item.featureId}. Nothing in Git changed.`);
                  })
                }
              />
              <a className={LINK_BTN} href={projectHref(item.projectKey, "runs", runId)}>
                Open run
              </a>
            </div>
          </>
        );
      }}
    </Loading>
  );
}
