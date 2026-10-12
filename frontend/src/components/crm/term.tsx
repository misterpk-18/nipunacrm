/** Hover help for CRM words: `<Term name="delivery_plan" />` shows the label with an info icon and a one-line plain explanation. */
import type { ReactNode } from "react";
import { Info } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export const GLOSSARY = {
  deal: {
    label: "Deal",
    help: "One course a person is considering. A lead becomes a deal when it is qualified and converted.",
  },
  pipeline_card: {
    label: "Pipeline card",
    help: "The person's place on the pipeline board. All their open courses at a branch sit on one card and share its stage.",
  },
  delivery_plan: {
    label: "Delivery plan",
    help: "Where and how the student will study (branch, classroom / online, start window), with their acceptance. Needed before invoicing.",
  },
  payment_claim: {
    label: "Payment claim",
    help: "Money someone says they paid. It counts as paid only after Accounts verifies it.",
  },
  receipt: {
    label: "Receipt",
    help: "Issued once, at verification. Only a verified claim has a receipt number.",
  },
  admission_token: {
    label: "Admission token",
    help: "The minimum verified money on a course (₹1,000 by default) that admits the student.",
  },
  fee_version: {
    label: "Fee version",
    help: "A saved price for the course: standard fee, offer and any concession. Changes make a new version; earlier ones are kept.",
  },
  special_closing: {
    label: "Special closing",
    help: "An approval request for an extra concession. Decided by a manager, or by the Founder / Super Admin below the 70% floor.",
  },
} as const;

export type TermName = keyof typeof GLOSSARY;

export function Term({
  name,
  children,
  className,
  iconOnly = false,
}: {
  name: TermName;
  children?: ReactNode;
  className?: string;
  iconOnly?: boolean;
}) {
  const entry = GLOSSARY[name];
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              "inline-flex cursor-help items-center gap-1 underline decoration-dotted decoration-muted-foreground/60 underline-offset-4",
              className,
            )}
          >
            {!iconOnly && (children ?? entry.label)}
            <Info
              className="size-3 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <span className="sr-only">{entry.help}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-64 leading-snug">
          {entry.help}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
