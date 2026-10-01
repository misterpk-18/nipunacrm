/** Workflow guide (V4, Phase 9): the record flow from enquiry to LMS, and what each record means. Static. */
import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { useAuth } from "@/auth/auth";
import { PageHead, Section } from "@/components/crm/ui";
import { useCanOpen } from "@/features/management/shared";

type Step = { title: string; detail: string; screen: string; to: string };

const STEPS: Step[] = [
  { title: "Capture", detail: "Record the enquiry once: person, course interest, source and branch. Duplicates are matched to the existing person.", screen: "Leads", to: "/leads" },
  { title: "Qualify", detail: "Work through the qualification checklist on Lead 360. A possible identity match is reviewed, never merged automatically.", screen: "Leads", to: "/leads" },
  { title: "Convert to deal", detail: "A qualified lead is converted with its course(s), branch, owner and expected close date. It then joins the person's pipeline card.", screen: "Deal pipeline", to: "/pipeline" },
  { title: "Accept delivery plan", detail: "Per course: service branch, mode, seat type and planned start, with the student's acceptance recorded.", screen: "Deal pipeline", to: "/pipeline" },
  { title: "Invoice", detail: "Issue one invoice for the person's eligible courses at one branch, with its 1–3 instalment schedule.", screen: "Invoices", to: "/invoices" },
  { title: "Record payment claim", detail: "Record money received against the invoice. Until it is verified it is only a claim — no receipt, no collection.", screen: "Payments & receipts", to: "/payments" },
  { title: "Verify", detail: "Accounts checks the evidence and verifies the claim. Only then is a receipt number issued and balances change.", screen: "Payments & receipts", to: "/payments" },
  { title: "Admission", detail: "Created per invoiced course once ₹1,000 is verified on it (or its whole amount, if smaller).", screen: "Admissions", to: "/admissions" },
  { title: "Batch", detail: "The Academic Coordinator allocates the student to a batch in the Nipuna LMS; the CRM shows it read-only. Separate from payment and from LMS access.", screen: "Batches", to: "/batches" },
  { title: "LMS review", detail: "Check curriculum mapping and the learner's LMS status. The LMS creates the login when the admission reaches it; its status comes back to the CRM.", screen: "LMS access", to: "/lms-access" },
];

const TRUTHS: [string, string][] = [
  ["Invoice", "the charge for one or more courses of one person at one branch."],
  ["Receipt", "a verified payment only. A pending claim is neither a receipt nor a collection, and never reduces the balance."],
  ["Instalments", "the invoice's own schedule of 1–3 instalments, with flexible dates and amounts."],
  ["Admission", "one per invoiced course, created once ₹1,000 is verified on that course (or its whole amount, if smaller)."],
  ["Batch and LMS", "batch allocation and LMS access are separate steps with their own status; neither changes the money."],
];

export function WorkflowGuidePage() {
  const { profile } = useAuth();
  const canOpen = useCanOpen();
  const role = [...new Set(profile?.scopes.map((s) => s.role_name))].join(" · ");
  return (
    <>
      <PageHead title="Workflow guide" description={`${role ? `${role} · ` : ""}how a record moves from first enquiry to LMS review, and what each record means.`} />
      <ol className="journey-stepper mb-6" aria-label="Workflow steps">
        {STEPS.map((s, i) => (
          <li key={s.title}>
            <span aria-hidden>{i + 1}</span>
            <b className="font-semibold">{s.title}</b>
          </li>
        ))}
      </ol>
      <div className="dash-grid mb-6 items-start">
        <Section title="Record truth" subtitle="What each record stands for — the rules every screen follows">
          <dl className="space-y-3 text-sm leading-relaxed">
            {TRUTHS.map(([term, text]) => (
              <div key={term}>
                <dt className="inline font-semibold text-foreground">{term}</dt> <dd className="inline text-[#41465c]">= {text}</dd>
              </div>
            ))}
          </dl>
        </Section>
        <Section title="Where each step happens" subtitle="Links open only the screens your role can use">
          <ol className="space-y-2">
            {STEPS.map((s, i) => (
              <li key={s.title} className="flex items-start gap-3 rounded-[10px] border p-3">
                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent text-xs font-semibold text-primary">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    <b className="text-sm font-semibold">{s.title}</b>
                    {canOpen(s.to) ? (
                      <Link to={s.to} className="inline-flex items-center gap-1 text-xs font-semibold text-primary">
                        {s.screen}
                        <ArrowRight className="size-3.5" />
                      </Link>
                    ) : (
                      <span className="text-xs text-muted-foreground">{s.screen}</span>
                    )}
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{s.detail}</p>
                </div>
              </li>
            ))}
          </ol>
        </Section>
      </div>
    </>
  );
}
