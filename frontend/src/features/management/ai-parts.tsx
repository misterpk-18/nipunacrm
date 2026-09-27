/** Shared AI pieces: feedback buttons, sources/freshness line, management brief card. */
import { useState } from "react";
import {
  AI_FEEDBACK_RATINGS,
  aiApi,
  useManagementBrief,
  type AiSource,
} from "@/api/ai";
import { Button } from "@/components/ui/button";
import { AiNote, ErrorPanel, LoadingRows } from "@/components/crm/ui";
import { dateTime } from "@/lib/format";
import { useApiMutation } from "@/lib/mutation";

export function FeedbackButtons({
  insightId,
  queryId,
}: {
  insightId?: number;
  queryId?: number;
}) {
  const [sent, setSent] = useState<string | null>(null);
  const send = useApiMutation(aiApi.feedback, {
    success: "Thanks — feedback recorded",
    onSuccess: (_r, v) => setSent(v.rating),
  });
  if (sent)
    return (
      <span className="text-xs text-muted-foreground">
        Feedback recorded: {sent}
      </span>
    );
  return (
    <div
      className="flex flex-wrap gap-2"
      role="group"
      aria-label="Rate this AI output"
    >
      {AI_FEEDBACK_RATINGS.map((rating) => (
        <Button
          key={rating}
          size="sm"
          variant="outline"
          disabled={send.isPending}
          onClick={() =>
            send.mutate({ insight_id: insightId, query_id: queryId, rating })
          }
        >
          {rating}
        </Button>
      ))}
    </div>
  );
}

export function sourcesText(sources: AiSource[] | null | undefined) {
  if (!sources?.length) return "—";
  return sources
    .map((s) => [s.type, s.name].filter(Boolean).join(": "))
    .join(", ");
}

export function modelLabel(model: string | null | undefined) {
  if (!model) return "Unknown";
  return model === "rules-fallback"
    ? "Rule-based summary (no AI model configured)"
    : model;
}

/** AI Management Brief for Founder / Admin / Branch Manager. */
export function ManagementBrief({
  period,
  branchId,
}: {
  period: string;
  branchId?: number;
}) {
  const brief = useManagementBrief({
    period: period === "Custom" ? "This Month" : period,
    branch_id: branchId,
  });
  if (brief.isLoading) return <LoadingRows rows={3} />;
  if (brief.error)
    return (
      <ErrorPanel error={brief.error} onRetry={() => void brief.refetch()} />
    );
  const b = brief.data!;
  return (
    <AiNote
      title="AI Management Brief"
      actions={<FeedbackButtons insightId={b.insight_id} />}
    >
      <div className="whitespace-pre-line">{b.content}</div>
      <p className="mt-2 text-xs text-muted-foreground">
        Evidence as of {dateTime(b.evidence_as_of)} · Sources:{" "}
        {sourcesText(b.sources)} · {modelLabel(b.model)} · Human review required
      </p>
    </AiNote>
  );
}
