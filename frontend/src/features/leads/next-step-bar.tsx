/** The next-step bar at the top of Lead 360: where the deal is, the ONE next action (opened as a dialog in place),
 *  why it is blocked and who must act when you can't. Everything comes from GET /leads/<id>/journey. */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CircleDot,
  Hourglass,
  Minus,
  X,
} from "lucide-react";
import {
  leadKeys,
  leadsApi,
  type Journey,
  type JourneyAction,
  type JourneyNext,
  type JourneyStep,
  type Lead,
} from "@/api/leads";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Term, type TermName } from "@/components/crm/term";
import { CreateInvoiceDialog } from "@/features/finance/create-invoice";
import { RecordPaymentDialog } from "@/features/finance/record-payment";
import { ClaimReviewDialog } from "@/features/finance/shared";
import { DeliveryPlanPanel } from "@/features/sales/deal-panels";
import { money } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ConvertDialog, QualificationPanel } from "./qualification";
import { OutcomeForm } from "./workbench";

/** Words that get hover help in the bar. */
const STEP_TERMS: Record<string, TermName> = {
  convert: "deal",
  fee: "fee_version",
  plan: "delivery_plan",
  payment: "payment_claim",
  verify: "receipt",
};
const ACTION_TERMS: Partial<Record<JourneyAction, TermName>> = {
  accept_plan: "delivery_plan",
  request_approval: "special_closing",
  record_payment: "payment_claim",
  verify_payment: "payment_claim",
};

const NO_BUTTON = new Set<JourneyAction>(["wait_batch", "none"]);

/** What the bar shows changes when a step finishes: compare before / after a dialog. */
const signature = (j: Journey) =>
  JSON.stringify([
    j.next?.action ?? null,
    j.next?.blocked ?? null,
    j.next?.can_act ?? null,
    j.steps.map((s) => s.status),
    j.after_admission?.trail.map((t) => t.status) ?? null,
    j.money?.verified ?? null,
    j.money?.pending ?? null,
  ]);

const istDay = (iso: string) =>
  new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

export type NextStepBarProps = {
  lead: Lead;
  /** Deep link (?action=<key>): open this action's dialog once, then call onInitialActionHandled */
  initialAction?: string | undefined;
  onInitialActionHandled?: (() => void) | undefined;
  /** Dialogs only the host screen owns (e.g. book_demo): called with a close function */
  renderers?:
    | Partial<Record<JourneyAction, (close: () => void) => ReactNode>>
    | undefined;
};

export function NextStepBar({
  lead,
  initialAction,
  onInitialActionHandled,
  renderers,
}: NextStepBarProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const journey = useQuery({
    queryKey: leadKeys.journey(lead.lead_id),
    queryFn: () => leadsApi.journey(lead.lead_id),
    refetchOnWindowFocus: true,
  });
  const [open, setOpen] = useState<JourneyAction | null>(null);
  const [notice, setNotice] = useState<{ next: JourneyNext | null } | null>(
    null,
  );
  const before = useRef<string | null>(null);
  const settling = useRef(false);
  const { refetch } = journey;
  const openRef = useRef<JourneyAction | null>(null);
  openRef.current = open;
  const data = journey.data;

  const goTo = useCallback(
    (action: JourneyAction, j: Journey | undefined) => {
      const ref = (j?.next?.action === action ? j.next.ref : undefined) ?? {};
      const leadId = lead.lead_id;
      if (action === "fee_discussion" || action === "request_approval") {
        if (action === "request_approval" && j?.next?.can_act && ref.scr_id)
          void navigate({
            to: "/discount-approval",
            search: { id: ref.scr_id },
          });
        else
          void navigate({
            to: "/fee-quote",
            search: ref.fee_discussion_id
              ? { leadId, discussionId: ref.fee_discussion_id }
              : { leadId },
          });
        return true;
      }
      if (action === "record_demo_outcome") {
        const day = ref.scheduled_at ? istDay(ref.scheduled_at) : undefined;
        void navigate({
          to: "/demos",
          search: day ? { from: day, to: day } : {},
        });
        return true;
      }
      if (action === "book_demo" && !renderers?.book_demo) {
        void navigate({ to: "/demos" });
        return true;
      }
      if (action === "verify_payment" && !ref.payment_id) {
        void navigate({
          to: "/payments",
          search: { status: "Pending Verification" },
        });
        return true;
      }
      return false;
    },
    [lead.lead_id, navigate, renderers],
  );

  const start = useCallback(
    (action: JourneyAction) => {
      if (NO_BUTTON.has(action)) return;
      if (goTo(action, journey.data)) return;
      before.current = journey.data ? signature(journey.data) : null;
      setNotice(null);
      setOpen(action);
    },
    [goTo, journey.data],
  );

  /** Refetch after a save; when the bar's step moved on, close the dialog and offer "Continue". Never auto-opens. */
  const settle = useCallback(
    async (closing: boolean) => {
      if (settling.current) return;
      settling.current = true;
      try {
        const fresh = (await refetch()).data;
        const changed =
          Boolean(fresh) &&
          before.current !== null &&
          signature(fresh!) !== before.current;
        if (closing || changed) setOpen(null);
        if (changed && fresh) {
          setNotice({ next: fresh.next });
          before.current = null;
        }
      } finally {
        settling.current = false;
      }
    },
    [refetch],
  );

  // Any saved change anywhere on the page refreshes the bar; while a dialog is open it also checks for progress.
  useEffect(
    () =>
      queryClient.getMutationCache().subscribe((event) => {
        if (event.type !== "updated" || event.action.type !== "success") return;
        if (openRef.current) void settle(false);
        else
          void queryClient.invalidateQueries({
            queryKey: leadKeys.journey(lead.lead_id),
          });
      }),
    [queryClient, settle, lead.lead_id],
  );

  // ?action=<key> opens that dialog once the journey is known
  const handled = useRef(false);
  useEffect(() => {
    if (!initialAction || handled.current || !data) return;
    handled.current = true;
    start(initialAction as JourneyAction);
    onInitialActionHandled?.();
  }, [initialAction, data, start, onInitialActionHandled]);

  if (lead.stage === "Lost - closed" || journey.isError) return null;
  if (!data)
    return (
      <div className="sticky top-2 z-20 mb-3 h-16 animate-pulse rounded-lg border bg-muted/40" />
    );

  const next = data.next;
  const finish = () => {
    setOpen(null);
    void settle(true);
  };
  const waiting = next !== null && !next.can_act && !NO_BUTTON.has(next.action);
  const hint =
    data.money && Number(data.money.more_to_admit) > 0 && !data.after_admission
      ? Number(data.money.more_to_admit)
      : 0;

  return (
    <section
      aria-label="Next step"
      className="sticky top-2 z-20 mb-3 rounded-lg border bg-background/95 p-3 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/85"
    >
      {data.after_admission ? (
        <Trail journey={data} />
      ) : (
        <Stepper steps={data.steps} />
      )}

      {notice && (
        <div
          className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm"
          role="status"
        >
          <Check className="size-4 text-success" />
          <span className="font-medium">Saved.</span>
          {notice.next &&
          !NO_BUTTON.has(notice.next.action) &&
          notice.next.can_act ? (
            <>
              <span>Continue to next step:</span>
              <Button size="sm" onClick={() => start(notice.next!.action)}>
                {notice.next.label}
                <ArrowRight />
              </Button>
            </>
          ) : (
            <span className="text-muted-foreground">
              {notice.next
                ? `Next: ${notice.next.label}${notice.next.role ? ` (${notice.next.role})` : ""}`
                : "Nothing more to do on this deal."}
            </span>
          )}
          <Button
            size="icon"
            variant="ghost"
            className="ml-auto size-6"
            aria-label="Dismiss"
            onClick={() => setNotice(null)}
          >
            <X />
          </Button>
        </div>
      )}

      {next && (
        <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {NO_BUTTON.has(next.action) ? "Status" : "Next step"}
              </span>
              <strong className="text-sm">
                {ACTION_TERMS[next.action] ? (
                  <Term name={ACTION_TERMS[next.action]!}>{next.label}</Term>
                ) : (
                  next.label
                )}
              </strong>
              {hint > 0 && (
                <span className="rounded-full bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning">
                  {money(hint)} more verified to admit{" "}
                  <Term
                    name="admission_token"
                    iconOnly
                    className="align-middle no-underline"
                  />
                </span>
              )}
            </div>
            {next.blocked && next.reason ? (
              <p className="mt-1 flex items-start gap-1.5 text-sm text-warning">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                {next.reason}
              </p>
            ) : waiting ? (
              <p className="mt-1 flex items-start gap-1.5 text-sm text-muted-foreground">
                <Hourglass className="mt-0.5 size-4 shrink-0" />
                {next.role ? `Waiting for ${next.role}. ` : ""}
                {next.detail}
              </p>
            ) : (
              next.detail && (
                <p className="mt-1 text-sm text-muted-foreground">
                  {next.detail}
                </p>
              )
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {next.blocked
              ? next.fix_action && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => start(next.fix_action!)}
                  >
                    {next.fix_label ?? "Fix it"}
                  </Button>
                )
              : !NO_BUTTON.has(next.action) &&
                next.can_act && (
                  <Button size="sm" onClick={() => start(next.action)}>
                    {next.label}
                    <ArrowRight />
                  </Button>
                )}
            {!next.blocked &&
              next.can_act &&
              next.alternatives.map((alt) => (
                <Button
                  key={alt.action}
                  size="sm"
                  variant="ghost"
                  onClick={() => start(alt.action)}
                >
                  {alt.label}
                </Button>
              ))}
          </div>
        </div>
      )}

      {open && (
        <ActionDialog
          action={open}
          lead={lead}
          journey={data}
          renderers={renderers}
          onClose={finish}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------- stepper and trail

function StepDot({ step, index }: { step: JourneyStep; index: number }) {
  const tone = {
    done: "border-success bg-success text-white",
    current:
      "border-primary bg-primary text-primary-foreground ring-2 ring-primary/25",
    blocked: "border-warning bg-warning/15 text-warning ring-2 ring-warning/25",
    skipped: "border-dashed border-muted-foreground/50 text-muted-foreground",
    todo: "border-border text-muted-foreground",
  }[step.status];
  return (
    <span
      className={cn(
        "grid size-5 shrink-0 place-items-center rounded-full border text-[10px] font-semibold",
        tone,
      )}
    >
      {step.status === "done" ? (
        <Check className="size-3" />
      ) : step.status === "blocked" ? (
        <AlertTriangle className="size-3" />
      ) : step.status === "skipped" ? (
        <Minus className="size-3" />
      ) : (
        index + 1
      )}
    </span>
  );
}

function Stepper({ steps }: { steps: JourneyStep[] }) {
  return (
    <ol
      className="flex items-center gap-1 overflow-x-auto pb-1"
      aria-label="Deal steps"
    >
      {steps.map((step, index) => {
        const term = STEP_TERMS[step.key];
        return (
          <li
            key={step.key}
            className="flex shrink-0 items-center gap-1"
            aria-current={
              step.status === "current" || step.status === "blocked"
                ? "step"
                : undefined
            }
            title={step.detail ?? undefined}
          >
            <StepDot step={step} index={index} />
            <span
              className={cn(
                "text-xs",
                step.status === "current" || step.status === "blocked"
                  ? "font-semibold text-foreground"
                  : step.status === "done"
                    ? "text-foreground"
                    : "text-muted-foreground",
                step.status === "skipped" && "line-through",
              )}
            >
              {term ? <Term name={term}>{step.label}</Term> : step.label}
              <span className="sr-only"> ({step.status})</span>
            </span>
            {index < steps.length - 1 && (
              <span className="mx-1 h-px w-3 bg-border" aria-hidden />
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** After the admission: Admitted → LMS login created → Batch allocated, each with what is known. */
function Trail({ journey }: { journey: Journey }) {
  const trail = journey.after_admission!.trail;
  return (
    <ol className="grid gap-2 sm:grid-cols-3" aria-label="After admission">
      {trail.map((t) => (
        <li
          key={t.key}
          className={cn(
            "flex min-w-0 items-start gap-2 rounded-md border px-2.5 py-2",
            t.status === "current" && "border-primary/50 bg-primary/5",
          )}
        >
          <span
            className={cn(
              "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border",
              t.status === "done"
                ? "border-success bg-success text-white"
                : t.status === "current"
                  ? "border-primary text-primary"
                  : "border-border text-muted-foreground",
            )}
          >
            {t.status === "done" ? (
              <Check className="size-3" />
            ) : (
              <CircleDot className="size-3" />
            )}
          </span>
          <span className="min-w-0 text-xs">
            <span className="block font-semibold">
              {t.label}
            </span>
            {t.detail && (
              <span className="block break-words text-muted-foreground">
                {t.detail}
              </span>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------- the dialogs

function PanelDialog({
  title,
  description,
  onClose,
  children,
  wide,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className={cn(
          "max-h-[92vh] w-[calc(100vw-1.5rem)] overflow-y-auto",
          wide ? "max-w-4xl" : "max-w-xl",
        )}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

/** action key → the existing screen part, opened in place (fee / approval / demo outcome / payment review fall back to their screens). */
function ActionDialog({
  action,
  lead,
  journey,
  renderers,
  onClose,
}: {
  action: JourneyAction;
  lead: Lead;
  journey: Journey;
  renderers: NextStepBarProps["renderers"];
  onClose: () => void;
}) {
  const ref = journey.next?.action === action ? journey.next.ref : {};
  const invoiceId = ref.invoice_id ?? journey.money?.invoice_id;
  switch (action) {
    case "save_outcome":
      return (
        <PanelDialog
          title="Save outcome"
          description="The actual result and the agreed next action, in one step"
          onClose={onClose}
        >
          <OutcomeForm lead={lead} />
        </PanelDialog>
      );
    case "qualify":
      return (
        <PanelDialog
          title="Qualification"
          description="Review every check, then Mark Qualified"
          onClose={onClose}
        >
          <QualificationPanel lead={lead} />
        </PanelDialog>
      );
    case "convert":
      return <ConvertDialog lead={lead} onClose={onClose} />;
    case "book_demo":
      return <>{renderers?.book_demo?.(onClose)}</>;
    case "accept_plan":
      return (
        <PanelDialog
          title="Delivery plan"
          description="Branch, mode and start window, with the student's acceptance"
          onClose={onClose}
        >
          <DeliveryPlanPanel lead={lead} />
        </PanelDialog>
      );
    case "create_invoice":
      return <CreateInvoiceDialog leadId={lead.lead_id} onClose={onClose} />;
    case "record_payment":
      return invoiceId ? (
        <RecordPaymentDialog
          invoiceId={invoiceId}
          open
          onOpenChange={(o) => !o && onClose()}
        />
      ) : null;
    case "verify_payment":
      return ref.payment_id ? (
        <ClaimReviewDialog paymentId={ref.payment_id} onClose={onClose} />
      ) : null;
    default:
      return renderers?.[action] ? <>{renderers[action]!(onClose)}</> : null;
  }
}
