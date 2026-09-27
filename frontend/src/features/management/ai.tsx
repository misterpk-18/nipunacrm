/** AI Copilot (next best actions + before-call brief) and Ask Nipuna (management Q&A). Advisory only. */
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQueries } from "@tanstack/react-query";
import { Bot, Send, Sparkles } from "lucide-react";
import { AI_LANGUAGES, aiApi, type AiAnswer, type AiInsight } from "@/api/ai";
import { leadKeys, leadsApi } from "@/api/leads";
import type { ManagementReport } from "@/api/reports";
import { useAuth, useBranchFilter } from "@/auth/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, NativeSelect } from "@/components/crm/forms";
import {
  AiNote,
  DataTable,
  Empty,
  Facts,
  PageHead,
  Section,
  Status,
} from "@/components/crm/ui";
import { date, dateTime, money } from "@/lib/format";
import { useApiMutation } from "@/lib/mutation";
import { FeedbackButtons, modelLabel, sourcesText } from "./ai-parts";
import { useCanOpen } from "./shared";

function LanguageToggle({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div
      className="flex rounded-md border p-1"
      role="group"
      aria-label="Language"
    >
      {AI_LANGUAGES.map((l) => (
        <Button
          key={l}
          size="sm"
          variant={value === l ? "secondary" : "ghost"}
          aria-pressed={value === l}
          onClick={() => onChange(l)}
        >
          {l === "Telugu" ? "తెలుగు" : l}
        </Button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- AI Copilot

export function AiCopilotPage() {
  const { hasRole } = useAuth();
  const canOpen = useCanOpen();
  const [lang, setLang] = useState("English");
  const [actions, setActions] = useState<AiInsight[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const canNba = hasRole("SALES", "FRONT_OFFICE", "BRANCH_MANAGER");
  const nba = useApiMutation(() => aiApi.nextBestAction(10), {
    onSuccess: (rows) => {
      setActions(rows);
      if (rows[0]?.lead_id) setSelected(rows[0].lead_id);
    },
  });
  const leadNames = useQueries({
    queries: (actions ?? [])
      .filter((a) => a.lead_id)
      .map((a) => ({
        queryKey: leadKeys.detail(a.lead_id!),
        queryFn: () => leadsApi.get(a.lead_id!),
        staleTime: 60_000,
      })),
  });
  const nameOf = (id: number | null) =>
    leadNames.find((q) => q.data?.lead_id === id)?.data;

  return (
    <>
      <PageHead
        title="AI Copilot"
        description="Advisory sales assistance · CRM facts remain distinct from AI inference · every output needs human review"
        actions={<LanguageToggle value={lang} onChange={setLang} />}
      />
      {!canNba ? (
        <Section title="Next best actions">
          <Empty title="Next best actions work on a counsellor's own lead queue">
            {canOpen("/ask-nipuna") && (
              <Button asChild size="sm" className="mt-2">
                <Link to="/ask-nipuna">
                  <Bot />
                  Ask Nipuna about the business
                </Link>
              </Button>
            )}
          </Empty>
        </Section>
      ) : (
        <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Section
            title="Next best actions"
            subtitle="Your queue, most urgent first"
            action={
              <Button
                size="sm"
                onClick={() => nba.mutate(undefined)}
                disabled={nba.isPending}
              >
                <Sparkles />
                {actions ? "Refresh suggestions" : "Suggest next actions"}
              </Button>
            }
            className="min-w-0"
          >
            {actions === null ? (
              <Empty title="No suggestions yet">
                Generate suggestions for the leads in your queue.
              </Empty>
            ) : actions.length === 0 ? (
              <Empty title="Your queue is clear">
                No open leads are assigned to you.
              </Empty>
            ) : (
              <ul className="space-y-2">
                {actions.map((a) => {
                  const lead = nameOf(a.lead_id);
                  return (
                    <li key={a.insight_id}>
                      <button
                        type="button"
                        onClick={() => setSelected(a.lead_id)}
                        className={`w-full rounded-md border p-3 text-left text-sm transition-colors hover:bg-muted/50 ${selected === a.lead_id ? "border-primary bg-accent/40" : ""}`}
                      >
                        <span className="flex flex-wrap items-center gap-2">
                          <strong>
                            {lead ? lead.name : `Lead #${a.lead_id}`}
                          </strong>
                          {lead && (
                            <span className="text-xs text-muted-foreground">
                              {lead.lead_code} · {lead.stage}
                            </span>
                          )}
                          {a.priority && <Status>{a.priority}</Status>}
                          {a.score !== null && (
                            <span className="text-xs text-muted-foreground">
                              score {a.score}
                            </span>
                          )}
                        </span>
                        <span className="mt-1 block">{a.content}</span>
                        <span className="mt-1 block text-[11px] text-muted-foreground">
                          {modelLabel(a.model)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>
          <div className="min-w-0 space-y-4">
            {selected ? (
              <LeadBrief leadId={selected} language={lang} />
            ) : (
              <Section title="Before-call brief">
                <Empty title="Pick a lead to brief" />
              </Section>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function LeadBrief({ leadId, language }: { leadId: number; language: string }) {
  const lead = useQueries({
    queries: [
      {
        queryKey: leadKeys.detail(leadId),
        queryFn: () => leadsApi.get(leadId),
      },
    ],
  })[0]!;
  const [result, setResult] = useState<{
    key: string;
    brief: AiInsight;
    why: AiInsight;
  } | null>(null);
  const key = `${leadId}-${language}`;
  const generate = useApiMutation(() => aiApi.leadBrief(leadId, language), {
    invalidate: [leadKeys.detail(leadId)],
    onSuccess: (r) =>
      setResult({ key, brief: r.brief, why: r.priority_explanation }),
  });
  const l = lead.data;
  const current = result?.key === key ? result : null;
  return (
    <>
      <Section title="CRM facts" subtitle="Recorded fields">
        {l ? (
          <Facts
            items={[
              [
                "Lead",
                <Link
                  key="l"
                  to="/leads/$leadId"
                  params={{ leadId: String(l.lead_id) }}
                  className="font-medium text-primary"
                >
                  {l.name}
                </Link>,
              ],
              ["Branch", l.branch.branch_name],
              ["Course", l.course?.course_title ?? "Not decided"],
              ["Stage", l.stage],
              [
                "Last contact",
                l.last_contacted_at ? dateTime(l.last_contacted_at) : "—",
              ],
              [
                "Next follow-up",
                l.next_follow_up_at ? dateTime(l.next_follow_up_at) : "—",
              ],
            ]}
          />
        ) : (
          <Empty title="Loading lead…" />
        )}
        <Button
          className="mt-4"
          size="sm"
          onClick={() => generate.mutate(undefined)}
          disabled={generate.isPending}
        >
          <Sparkles />
          {current ? "Regenerate brief" : "Generate before-call brief"}
        </Button>
      </Section>
      {current && (
        <>
          <AiNote
            title={`AI Before-call Brief · evidence ${dateTime(current.brief.evidence_as_of)}`}
            actions={<FeedbackButtons insightId={current.brief.insight_id} />}
          >
            <div className="whitespace-pre-line">{current.brief.content}</div>
            <p className="mt-2 text-xs text-muted-foreground">
              Sources: {sourcesText(current.brief.sources)} ·{" "}
              {modelLabel(current.brief.model)}
            </p>
          </AiNote>
          <AiNote title="Why this priority · AI inference · human review required">
            <div className="whitespace-pre-line">{current.why.content}</div>
          </AiNote>
          {current.brief.suggested_message && (
            <AiNote title="Suggested WhatsApp">
              <div className="whitespace-pre-line">
                {current.brief.suggested_message}
              </div>
            </AiNote>
          )}
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Ask Nipuna

const SUGGESTIONS = [
  "Which courses have high enquiries but low admissions?",
  "Which counsellors have overdue follow-ups?",
  "What collections are at risk this week?",
  "How did verified collections compare across branches this month?",
];

export function AskNipunaPage() {
  const branchId = useBranchFilter();
  const { branches } = useAuth();
  const [question, setQuestion] = useState(SUGGESTIONS[0]!);
  const [language, setLanguage] = useState("English");
  const [period, setPeriod] = useState("This Month");
  const [answers, setAnswers] = useState<AiAnswer[]>([]);
  const ask = useApiMutation(aiApi.ask, {
    onSuccess: (a) => setAnswers((prev) => [a, ...prev]),
  });
  const scope = branchId
    ? (branches.find((b) => b.branch_id === branchId)?.branch_name ??
      "Selected branch")
    : "All branches in your scope";

  return (
    <>
      <PageHead
        title="Ask Nipuna"
        description="Management analytics assistant · answers from recorded CRM figures with explicit scope · advisory only"
      />
      <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-4">
          <form
            className="panel"
            onSubmit={(e) => {
              e.preventDefault();
              if (question.trim())
                ask.mutate({
                  question: question.trim(),
                  language,
                  period,
                  branch_id: branchId,
                });
            }}
          >
            <div className="flex min-w-0 gap-2">
              <Input
                className="min-w-0"
                aria-label="Question"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                maxLength={2000}
              />
              <Button
                type="submit"
                disabled={ask.isPending || !question.trim()}
              >
                <Send />
                Ask
              </Button>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field label="Period" htmlFor="ask-period">
                <NativeSelect
                  id="ask-period"
                  value={period}
                  onChange={(e) => setPeriod(e.target.value)}
                  options={[
                    "Today",
                    "Yesterday",
                    "This Week",
                    "Last Week",
                    "This Month",
                    "Last Month",
                  ].map((p) => ({ value: p, label: p }))}
                />
              </Field>
              <Field label="Answer language" htmlFor="ask-lang">
                <NativeSelect
                  id="ask-lang"
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  options={AI_LANGUAGES.map((l) => ({ value: l, label: l }))}
                />
              </Field>
            </div>
            <div className="mt-3 flex min-w-0 flex-wrap gap-2">
              {SUGGESTIONS.map((x) => (
                <Button
                  key={x}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-auto max-w-full whitespace-normal text-left"
                  onClick={() => setQuestion(x)}
                >
                  {x}
                </Button>
              ))}
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Branch scope: {scope} (use the branch switcher in the header to
              change it).
            </p>
          </form>
          {answers.length === 0 ? (
            <Section title="Answer">
              <Empty title="Ask a question about collections, admissions or the lead funnel" />
            </Section>
          ) : (
            answers.map((a) => (
              <AnswerCard key={a.query_id} answer={a} scope={scope} />
            ))
          )}
        </div>
        <div className="self-start">
          <AiNote title="AI Method Note">
            Answers use recorded CRM figures (management and funnel reports) for
            the selected period and branch scope. Figures are descriptive, not
            forecasts. When no AI model is configured the answer lists the
            recorded figures only. Every answer needs human review before acting
            on it.
          </AiNote>
        </div>
      </div>
    </>
  );
}

function AnswerCard({ answer: a, scope }: { answer: AiAnswer; scope: string }) {
  const table = a.supporting_table as ManagementReport | null;
  return (
    <Section
      title={a.question}
      subtitle={`Asked ${dateTime(a.created_at)} · ${modelLabel(a.model)}`}
    >
      <dl className="mb-4 grid gap-2 text-sm sm:grid-cols-2">
        {[
          ["Sources / Evidence", sourcesText(a.sources)],
          [
            "Selected Period",
            `${date(a.period_start)} – ${date(a.period_end)}`,
          ],
          ["Branch Scope", scope],
          ["Report Cutoff", dateTime(a.report_cutoff_at)],
          ["Data Freshness", a.data_freshness],
          ["Language", a.language],
        ].map(([label, value]) => (
          <div key={label} className="border-b pb-2">
            <dt className="font-semibold">{label}</dt>
            <dd className="text-muted-foreground">{value}</dd>
          </div>
        ))}
      </dl>
      <AiNote title="Answer" actions={<FeedbackButtons queryId={a.query_id} />}>
        <p className="whitespace-pre-line">{a.answer}</p>
        <p className="mt-3 whitespace-pre-line">
          <b>Recorded facts:</b> {a.recorded_facts}
        </p>
        <p className="mt-2 whitespace-pre-line">
          <b>Possible explanation:</b> {a.possible_explanation}
        </p>
        <p className="mt-2 whitespace-pre-line">
          <b>Missing evidence:</b> {a.missing_evidence}
        </p>
      </AiNote>
      {table?.branches && (
        <div className="mt-4">
          <h3 className="mb-2 text-sm font-semibold">Supporting table</h3>
          <DataTable
            rows={table.branches}
            rowKey={(r) => r.branch.branch_id}
            columns={[
              { header: "Branch", cell: (r) => r.branch.branch_name },
              { header: "Verified net", cell: (r) => money(r.net) },
              { header: "Refunds", cell: (r) => money(r.refunds) },
              {
                header: "Pending (excluded)",
                cell: (r) => money(r.pending_verification_excluded),
              },
              {
                header: "New paid admissions",
                cell: (r) => r.new_paid_admissions,
              },
            ]}
          />
        </div>
      )}
    </Section>
  );
}
