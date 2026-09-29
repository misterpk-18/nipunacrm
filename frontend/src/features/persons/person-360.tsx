import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { GraduationCap, Mail, MessageCircle, Phone, PlusCircle } from "lucide-react";
import { usePersonOverview, type PersonOverview } from "@/api/persons";
import { Button } from "@/components/ui/button";
import { DataTable, Empty, ErrorPanel, Facts, LoadingRows, PageHead, Section, Status } from "@/components/crm/ui";
import { date, dateTime, money, phone } from "@/lib/format";
import { followUpLabel } from "@/features/leads/leads-list";
import { NewLeadDialog } from "@/features/leads/new-lead-dialog";

/** Person 360: profile, pipeline cards (one per branch), every lead / course and every admission. */
export function Person360({ personId }: { personId: number }) {
  const overview = usePersonOverview(personId);
  const [another, setAnother] = useState(false);
  if (overview.isLoading) return <LoadingRows rows={8} />;
  if (overview.error) return <ErrorPanel error={overview.error} onRetry={() => void overview.refetch()} />;
  const { person: p, pipeline_cards, leads, admissions } = overview.data!;
  const digits = p.phone.replace(/\D/g, "");

  return (
    <>
      <PageHead
        title={p.full_name}
        description={`${p.person_code} · registered at ${p.registered_branch.branch_name} · since ${date(p.created_at)}`}
        actions={
          <>
            <Button asChild>
              <a href={`tel:+${digits}`}>
                <Phone />
                Call
              </a>
            </Button>
            <Button variant="outline" asChild>
              <a href={`https://wa.me/${(p.whatsapp_number ?? p.phone).replace(/\D/g, "")}`} target="_blank" rel="noreferrer">
                <MessageCircle />
                WhatsApp
              </a>
            </Button>
            {p.email && (
              <Button variant="outline" asChild>
                <a href={`mailto:${p.email}`}>
                  <Mail />
                  Email
                </a>
              </Button>
            )}
            <Button variant="outline" onClick={() => setAnother(true)}>
              <PlusCircle />
              New enquiry
            </Button>
            {admissions.length > 0 && (
              <Button variant="outline" asChild>
                <Link to="/students/$personId" params={{ personId: String(p.person_id) }}>
                  <GraduationCap />
                  Student 360
                </Link>
              </Button>
            )}
          </>
        }
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          <PipelineCards cards={pipeline_cards} />
          <Leads leads={leads} />
          <Admissions admissions={admissions} />
        </div>
        <Section title="Profile" className="h-fit">
          <Facts
            columns={1}
            items={[
              ["Mobile", phone(p.phone)],
              ["Alternate", p.alternate_phone ? phone(p.alternate_phone) : "—"],
              ["WhatsApp", p.whatsapp_number ? phone(p.whatsapp_number) : "Same as mobile"],
              ["Email", p.email ?? "—"],
              ["City", p.city ?? "—"],
              ["Highest qualification", p.highest_qualification ?? "—"],
              ["Preferred language", p.preferred_language],
            ]}
          />
        </Section>
      </div>
      <NewLeadDialog open={another} onOpenChange={setAnother} person={p} />
    </>
  );
}

function PipelineCards({ cards }: { cards: PersonOverview["pipeline_cards"] }) {
  return (
    <Section title="Pipeline" subtitle="One card per branch. All open courses on a card share its stage.">
      {cards.length === 0 ? (
        <Empty title="Not in the pipeline">A lead joins the pipeline on its first stage change.</Empty>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {cards.map((c) => (
            <article key={c.pipeline_entry_id} className={`rounded-md border p-3 ${c.is_open ? "" : "opacity-70"}`} aria-label={`Pipeline card ${c.entry_code}`}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold">{c.branch.branch_name}</p>
                  <p className="text-xs text-muted-foreground">{c.entry_code}</p>
                </div>
                <Status kind={c.is_open ? undefined : c.stage === "Admitted" ? "good" : "neutral"}>{c.stage}</Status>
              </div>
              <Facts
                columns={2}
                items={[
                  ["Owner", c.owner?.full_name ?? "Unassigned"],
                  [c.is_open ? "Next follow-up" : "Closed", c.is_open ? followUpLabel(c) : dateTime(c.closed_at)],
                ]}
              />
              {c.courses.length > 0 && (
                <ul className="mt-3 space-y-1 text-sm">
                  {c.courses.map((course) => (
                    <li key={course.lead_id}>
                      <Link to="/leads/$leadId" params={{ leadId: String(course.lead_id) }} className="text-primary">
                        {course.course?.course_title ?? "No course yet"}
                      </Link>{" "}
                      <small className="text-muted-foreground">{course.lead_code}</small>
                    </li>
                  ))}
                </ul>
              )}
              {c.is_open && (
                <Button size="sm" variant="outline" className="mt-3" asChild>
                  <Link to="/pipeline" search={{ q: c.entry_code }}>
                    Open in pipeline
                  </Link>
                </Button>
              )}
            </article>
          ))}
        </div>
      )}
    </Section>
  );
}

function Leads({ leads }: { leads: PersonOverview["leads"] }) {
  const navigate = useNavigate();
  return (
    <Section title="Leads" subtitle="Every enquiry, one per course. Active = New Enquiry; Inactive = in the pipeline or closed.">
      <DataTable
        rows={leads}
        rowKey={(l) => l.lead_id}
        onRowClick={(l) => void navigate({ to: "/leads/$leadId", params: { leadId: String(l.lead_id) } })}
        empty={<Empty title="No leads at your branches" />}
        columns={[
          {
            header: "Lead",
            cell: (l) => (
              <Link to="/leads/$leadId" params={{ leadId: String(l.lead_id) }} className="font-semibold text-primary" onClick={(e) => e.stopPropagation()}>
                {l.lead_code}
              </Link>
            ),
          },
          { header: "Course", cell: (l) => l.course?.course_title ?? "—" },
          { header: "Branch", cell: (l) => l.branch.branch_name },
          { header: "Status", cell: (l) => <Status kind={l.lead_status === "Active" ? undefined : "neutral"}>{l.lead_status}</Status> },
          { header: "Stage", cell: (l) => <Status>{l.stage}</Status> },
          { header: "Owner", cell: (l) => l.owner?.full_name ?? "Unassigned" },
          { header: "Source", cell: (l) => l.original_source },
          { header: "Age", cell: (l) => `${l.age_days}d` },
        ]}
      />
    </Section>
  );
}

function Admissions({ admissions }: { admissions: PersonOverview["admissions"] }) {
  if (admissions.length === 0) return null;
  return (
    <Section title="Admissions">
      <DataTable
        rows={admissions}
        rowKey={(a) => a.admission_id}
        columns={[
          { header: "Admission", cell: (a) => a.admission_code },
          { header: "Course", cell: (a) => a.course.course_title },
          { header: "Branch", cell: (a) => a.service_branch.branch_name },
          { header: "Date", cell: (a) => date(a.admission_date) },
          { header: "Fee", cell: (a) => money(a.final_fee) },
          { header: "Outstanding", cell: (a) => money(a.outstanding) },
          { header: "Enrolment", cell: (a) => <Status>{a.enrolment_status}</Status> },
        ]}
      />
    </Section>
  );
}
