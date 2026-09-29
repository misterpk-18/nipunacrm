/** V4 lead display parts shared by Leads and My work: identity cell, call / WhatsApp buttons, phone card. */
import { Link } from "@tanstack/react-router";
import { Phone } from "lucide-react";
import type { LeadRow } from "@/api/leads";
import { Avatar, LeadChip, PriorityChip, WhatsAppButton } from "@/components/crm/ui";
import { Button } from "@/components/ui/button";
import { dateTime, maskPhone } from "@/lib/format";

/** Avatar + name (links to Lead 360) + code · branch. */
export function LeadIdentity({ lead }: { lead: LeadRow }) {
  return (
    <span className="identity-cell">
      <Avatar name={lead.name} />
      <span className="min-w-0">
        <Link to="/leads/$leadId" params={{ leadId: String(lead.lead_id) }} className="font-semibold text-foreground hover:text-primary" onClick={(e) => e.stopPropagation()}>
          <b className="!inline">{lead.name}</b>
        </Link>
        <small>
          {lead.lead_code} · {lead.branch.branch_name}
        </small>
      </span>
    </span>
  );
}

/** Course over original source. */
export function CourseSource({ lead }: { lead: Pick<LeadRow, "course" | "original_source"> }) {
  return (
    <span className="block min-w-[110px]">
      <span className="block max-w-56 truncate">{lead.course?.course_title ?? "Not sure yet"}</span>
      <small className="block">{lead.original_source}</small>
    </span>
  );
}

/** Call + WhatsApp. `prominent` = labelled buttons (phone cards), otherwise icon buttons (tables). */
export function LeadContact({ phone, prominent = false }: { phone: string; prominent?: boolean }) {
  const digits = phone.replace(/\D/g, "");
  return (
    <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
      <Button size={prominent ? "sm" : "icon"} variant={prominent ? "default" : "ghost"} title="Call" aria-label={prominent ? undefined : "Call"} asChild>
        <a href={`tel:+${digits}`}>
          <Phone />
          {prominent && "Call"}
        </a>
      </Button>
      <WhatsAppButton phone={phone} iconOnly={!prominent} />
    </div>
  );
}

/** Lead as a phone card (V4 mobile register). */
export function LeadMobileCard({ lead, selected, onToggle }: { lead: LeadRow; selected?: boolean; onToggle?: () => void }) {
  return (
    <div className="mobile-lead-card">
      <div className="flex items-start justify-between gap-3">
        <label className="flex min-w-0 items-start gap-2">
          {onToggle && <input type="checkbox" className="mt-1" aria-label={`Select ${lead.name}`} checked={Boolean(selected)} onChange={onToggle} />}
          <span className="min-w-0">
            <Link to="/leads/$leadId" params={{ leadId: String(lead.lead_id) }} className="font-semibold text-primary">
              {lead.name}
            </Link>
            <span className="mt-1 block text-xs text-muted-foreground">
              {lead.course?.course_title ?? "Not sure yet"} · {lead.stage}
            </span>
          </span>
        </label>
        <span className="shrink-0">{lead.ai_priority ? <PriorityChip priority={lead.ai_priority} /> : lead.intake_status === "New" ? <LeadChip value="New" /> : null}</span>
      </div>
      <div className="my-3 space-y-1 text-xs">
        <div>
          {maskPhone(lead.phone)} · {lead.next_follow_up_at ? dateTime(lead.next_follow_up_at) : "Unscheduled"}
        </div>
        <div className="break-words text-muted-foreground">
          {lead.branch.branch_name} · {lead.owner?.full_name ?? "Unassigned"} · {lead.original_source} · {lead.intake_status}
        </div>
      </div>
      <LeadContact phone={lead.phone} prominent />
    </div>
  );
}
