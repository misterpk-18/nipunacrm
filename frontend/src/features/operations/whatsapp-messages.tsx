/** WhatsApp messages: every message the CRM sent, with its delivery status, plus retry for failed or skipped ones. */
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useBranches } from "@/api/reference";
import { WHATSAPP_CATEGORIES, WHATSAPP_STATUSES, problemOf, useWhatsappMessages, useWhatsappSummary, type WhatsappFilters, type WhatsappMessage } from "@/api/whatsapp";
import { useBranchFilter } from "@/auth/auth";
import { NativeSelect } from "@/components/crm/forms";
import { DataTable, Empty, Facts, PageHead, Pagination, StatTile, Warning } from "@/components/crm/ui";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { templateLabel } from "@/features/persons/whatsapp-tab";
import { dateTime, phone } from "@/lib/format";
import { RetryButton, RetryDialog, StatusChip, useTemplateCatalogue } from "./whatsapp-shared";

export type WhatsappSearch = Omit<WhatsappFilters, "per_page" | "branch_id" | "person_id" | "template">;

const preview = (text: string) => (text.length > 90 ? `${text.slice(0, 90)}…` : text);

export function WhatsappMessagesPage({ search, onSearch }: { search: WhatsappSearch; onSearch: (next: WhatsappSearch) => void }) {
  const branchId = useBranchFilter();
  const branches = useBranches().data;
  const templates = useTemplateCatalogue();
  const [text, setText] = useState(search.q ?? "");
  const [open, setOpen] = useState<WhatsappMessage | null>(null);
  const [retrying, setRetrying] = useState<WhatsappMessage | null>(null);
  const rows = useWhatsappMessages({ ...search, branch_id: branchId, per_page: 25 });
  const summary = useWhatsappSummary(branchId).data;
  const set = (patch: Partial<WhatsappSearch>) => onSearch({ ...search, ...patch, page: undefined });
  const branchName = (id: number) => branches?.find((b) => b.branch_id === id)?.branch_name ?? `Branch #${id}`;

  return (
    <>
      <PageHead eyebrow="" title="WhatsApp messages" description="Every WhatsApp message the CRM sent, including those it sends for the LMS, with the exact text and its delivery status." />
      <div className="mb-5 grid gap-2">
        {summary && !summary.sending && <Warning>WhatsApp sending is switched off — messages are waiting.</Warning>}
        {summary?.test_numbers_only && <Warning>Only test numbers are being messaged.</Warning>}
      </div>
      <div className="mb-5 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6 lg:gap-4" aria-label="Message status">
        {WHATSAPP_STATUSES.map((s) => (
          <StatTile key={s} label={s} value={summary ? (summary.counts[s] ?? 0) : "…"} active={search.status === s} onClick={() => set({ status: search.status === s ? undefined : s })} />
        ))}
      </div>
      <section className="panel">
        <div className="section-head mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2>Messages</h2>
          {rows.data && <span className="text-xs text-muted-foreground">{rows.data.meta.total} messages</span>}
        </div>
        <div className="mb-4 flex flex-wrap gap-2">
          <form
            className="relative min-w-0 flex-1 basis-60"
            onSubmit={(e) => {
              e.preventDefault();
              set({ q: text.trim() || undefined });
            }}
          >
            <Search className="absolute left-3 top-3 size-4 text-muted-foreground" />
            <Input className="pl-9" placeholder="Search learner, phone or message" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search messages" />
          </form>
          <div className="min-w-0 flex-1 basis-40 sm:max-w-48 sm:flex-none">
            <NativeSelect aria-label="Status" value={search.status ?? ""} placeholder="Any status" options={WHATSAPP_STATUSES.map((s) => ({ value: s, label: s }))} onChange={(e) => set({ status: e.target.value || undefined })} />
          </div>
          <div className="min-w-0 flex-1 basis-40 sm:max-w-48 sm:flex-none">
            <NativeSelect aria-label="Category" value={search.category ?? ""} placeholder="Any category" options={WHATSAPP_CATEGORIES.map((s) => ({ value: s, label: s }))} onChange={(e) => set({ category: e.target.value || undefined })} />
          </div>
          {Object.keys(search).some((k) => k !== "page") && (
            <Button
              variant="ghost"
              onClick={() => {
                setText("");
                onSearch({});
              }}
            >
              Clear
            </Button>
          )}
        </div>
        <DataTable
          stack
          rows={rows.data?.data}
          loading={rows.isLoading}
          error={rows.error}
          onRetry={() => void rows.refetch()}
          rowKey={(m) => m.outbox_id}
          onRowClick={setOpen}
          empty={<Empty title="No messages match">Messages appear here once the CRM sends them.</Empty>}
          columns={[
            { header: "When", cell: (m) => dateTime(m.sent_at ?? m.created_at) },
            {
              header: "Learner",
              cell: (m) => (
                <span className="block">
                  {m.person_id ? (
                    <Link to="/persons/$personId" params={{ personId: String(m.person_id) }} className="font-semibold text-primary" onClick={(e) => e.stopPropagation()}>
                      {m.recipient_kind === "Staff" ? "About " : ""}
                      {m.person_name ?? `Learner #${m.person_id}`}
                    </Link>
                  ) : (
                    <span className="font-semibold">Not in the CRM</span>
                  )}
                  <small className="block">
                    {m.sent_by === "LMS" ? <span className="font-semibold">From the LMS · </span> : null}
                    {m.recipient_kind === "Staff" ? <span className="font-semibold">Staff: {m.recipient_name ?? "staff member"} · </span> : null}
                    {m.to_phone ? phone(m.to_phone) : "No number"}
                  </small>
                </span>
              ),
            },
            {
              header: "Template",
              cell: (m) => (
                <span className="block">
                  {templateLabel(templates, m.template_name)}
                  <small className="block">{m.category}</small>
                </span>
              ),
            },
            { header: "Message", cell: (m) => <span className="line-clamp-2 block max-w-xs whitespace-normal break-words">{preview(m.body_text)}</span> },
            { header: "Status", cell: (m) => <StatusChip status={m.status} /> },
            { header: "Branch", cell: (m) => m.branch_name ?? (m.branch_id ? branchName(m.branch_id) : "—") },
            { header: "", cell: (m) => <RetryButton message={m} onRetry={setRetrying} /> },
          ]}
        />
        <Pagination meta={rows.data?.meta} onPage={(page) => onSearch({ ...search, page })} />
      </section>
      {open && (
        <Dialog open onOpenChange={(o) => !o && setOpen(null)}>
          <DialogContent className="max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{templateLabel(templates, open.template_name)}</DialogTitle>
            </DialogHeader>
            <div className="grid gap-3 text-sm">
              <p className="whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3">{open.body_text}</p>
              {problemOf(open) && <p className="break-words text-destructive">{open.status}: {problemOf(open)}</p>}
              <Facts
                columns={2}
                items={[
                  ["Status", <StatusChip key="s" status={open.status} />],
                  ["Branch", open.branch_name ?? (open.branch_id ? branchName(open.branch_id) : "—")],
                  ["Sent by", open.sent_by === "LMS" ? "The LMS (it resends its own messages)" : "The CRM"],
                  ["To", open.to_phone ? phone(open.to_phone) : "No number"],
                  ["Attempts", String(open.attempts)],
                  ["Created", dateTime(open.created_at)],
                  ["Sent", open.sent_at ? dateTime(open.sent_at) : "—"],
                  ["Delivered", open.delivered_at ? dateTime(open.delivered_at) : "—"],
                  ["Read", open.read_at ? dateTime(open.read_at) : "—"],
                ]}
              />
              <div className="flex flex-wrap gap-2">
                {open.person_id ? (
                  <Button size="sm" variant="outline" asChild>
                    <Link to="/persons/$personId" params={{ personId: String(open.person_id) }}>
                      Open learner
                    </Link>
                  </Button>
                ) : null}
                <RetryButton
                  message={open}
                  onRetry={(m) => {
                    setOpen(null);
                    setRetrying(m);
                  }}
                />
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
      {retrying && <RetryDialog message={retrying} onClose={() => setRetrying(null)} />}
    </>
  );
}
