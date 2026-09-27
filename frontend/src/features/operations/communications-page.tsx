import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ListChecks, Plus, Search } from "lucide-react";
import {
  communicationKeys,
  communicationsApi,
  COMM_QUEUES,
  DELIVERY_STATUSES,
  MATCH_STATUSES,
  SLA_STATES,
  type CommFilters,
  type Communication,
  type NewCommunication,
} from "@/api/communications";
import { leadsApi, type Person } from "@/api/leads";
import { useBranches } from "@/api/reference";
import { useAuth, useBranchFilter } from "@/auth/auth";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { BranchSelect, Field, LookupSelect, NativeSelect, applyServerErrors } from "@/components/crm/forms";
import { ConfirmAction, DataTable, Empty, ErrorPanel, LoadingRows, PageHead, Pagination, Status, Warning } from "@/components/crm/ui";
import { dateTime, fromLocalInput, relative } from "@/lib/format";
import { useApiMutation } from "@/lib/mutation";

export type CommSearch = { queue?: string; sla_state?: string; match_status?: string; page?: number };

const invalidate = [communicationKeys.all, ["leads"], ["tasks"]];

function usePersonName(personId: number | null) {
  return useQuery({
    queryKey: ["persons", personId],
    queryFn: () => leadsApi.getPerson(personId!),
    enabled: personId !== null,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

function PersonCell({ c }: { c: Communication }) {
  const person = usePersonName(c.person_id);
  const address = c.direction === "Inbound" ? c.from_address : c.to_address;
  const name = person.data?.full_name ?? (c.person_id ? `Person #${c.person_id}` : null);
  return (
    <span className="block min-w-0">
      <span className="font-semibold">{c.match_status === "Matched" && name ? name : address ?? "Unknown sender"}</span>
      <small className="block text-[11px] text-muted-foreground">
        {c.match_status === "Matched" ? address ?? "" : c.match_status === "Match Review" && name ? `Possible match: ${name}` : c.match_status}
        {c.lead_id ? (
          <>
            {" · "}
            <Link to="/leads/$leadId" params={{ leadId: String(c.lead_id) }} className="text-primary" onClick={(e) => e.stopPropagation()}>
              Lead #{c.lead_id}
            </Link>
          </>
        ) : null}
      </small>
    </span>
  );
}

function SlaCell({ c }: { c: Communication }) {
  if (!c.needs_response) return <span className="text-muted-foreground">No response needed</span>;
  if (c.responded_at) return <Status>{c.sla_state ?? "Met"}</Status>;
  return (
    <span>
      <Status>{c.sla_state ?? "Awaiting Reply"}</Status>
      {c.response_due_at && <small className="mt-1 block text-[11px] text-muted-foreground">Response due {relative(c.response_due_at)}</small>}
    </span>
  );
}

function Message({ c }: { c: Communication }) {
  const text = c.subject || c.body || (c.call_duration_seconds !== null ? `Call · ${c.call_duration_seconds}s` : "—");
  return (
    <span className="block max-w-64 truncate" title={c.body ?? undefined}>
      {text}
      {c.failure_reason && <small className="block text-[11px] text-destructive">{c.failure_reason}</small>}
      {c.retry_of_id && <small className="block text-[11px] text-muted-foreground">Retry of #{c.retry_of_id}</small>}
    </span>
  );
}

/** Communications inbox: queues, SLA indicators, manual logging, reply / match / retry. */
export function CommunicationsPage({ search, onSearch }: { search: CommSearch; onSearch: (next: CommSearch) => void }) {
  const branchId = useBranchFilter();
  const { data: branches } = useBranches();
  const [logOpen, setLogOpen] = useState(false);
  const [matching, setMatching] = useState<Communication | null>(null);
  const [replying, setReplying] = useState<Communication | null>(null);
  const filters: CommFilters = { ...search, branch_id: branchId, per_page: 25 };
  const comms = useQuery({ queryKey: communicationKeys.list(filters), queryFn: () => communicationsApi.list(filters), placeholderData: (prev) => prev });
  const rows = comms.data?.data;
  const tab = search.queue ?? "All";
  const branchName = (id: number) => branches?.find((b) => b.branch_id === id)?.branch_name ?? String(id);
  const set = (patch: Partial<CommSearch>) => {
    const next: CommSearch = { ...search, ...patch, page: undefined };
    for (const key of Object.keys(next) as (keyof CommSearch)[]) if (next[key] === undefined || next[key] === "") delete next[key];
    onSearch(next);
  };

  const retry = useApiMutation((id: number) => communicationsApi.retry(id, { delivery_status: "Sent" }), { success: "Retry logged", invalidate });

  const actions = (c: Communication) => (
    <div className="flex flex-wrap gap-1" onClick={(e) => e.stopPropagation()}>
      {c.direction === "Inbound" && c.needs_response && !c.responded_at && (
        <Button size="sm" onClick={() => setReplying(c)}>
          Reply
        </Button>
      )}
      {c.match_status !== "Matched" && (
        <Button size="sm" variant="outline" onClick={() => setMatching(c)}>
          Match
        </Button>
      )}
      {c.delivery_status === "Failed" && (
        <ConfirmAction
          trigger={
            <Button size="sm" variant="outline">
              Retry
            </Button>
          }
          title="Retry this communication?"
          description="Logs a new send attempt linked to the failed one. The failed record stays in history."
          action="Log retry"
          onConfirm={() => retry.mutateAsync(c.communication_id)}
        />
      )}
    </div>
  );

  return (
    <>
      <PageHead
        title="Communications"
        description="Unified inbox · recorded manually until channel integrations are live · no automatic sync"
        actions={
          <>
            <Button onClick={() => setLogOpen(true)}>
              <Plus />
              Log communication
            </Button>
            <Button variant="outline" asChild>
              <Link to="/tasks" search={{ tab: "Team Tasks", type: "CALL" }}>
                <ListChecks />
                Call tasks
              </Link>
            </Button>
          </>
        }
      />
      <div className="panel">
        <Tabs value={tab} onValueChange={(t) => set({ queue: t === "All" ? undefined : t })}>
          <TabsList className="mb-4 h-auto max-w-full flex-wrap justify-start overflow-x-auto">
            {["All", ...COMM_QUEUES].map((t) => (
              <TabsTrigger key={t} value={t}>
                {t}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="mb-3 flex flex-wrap gap-3">
          <Field label="SLA state" htmlFor="cf-sla" className="w-44 min-w-0">
            <NativeSelect id="cf-sla" value={search.sla_state ?? ""} placeholder="Any" options={SLA_STATES.map((s) => ({ value: s, label: s }))} onChange={(e) => set({ sla_state: e.target.value })} />
          </Field>
          <Field label="Match status" htmlFor="cf-match" className="w-44 min-w-0">
            <NativeSelect id="cf-match" value={search.match_status ?? ""} placeholder="Any" options={MATCH_STATUSES.map((s) => ({ value: s, label: s }))} onChange={(e) => set({ match_status: e.target.value })} />
          </Field>
        </div>
        <div className="table-desktop">
          <DataTable
            rows={rows}
            loading={comms.isLoading}
            error={comms.error}
            onRetry={() => void comms.refetch()}
            rowKey={(c) => c.communication_id}
            empty={<Empty title={`Nothing in ${tab}`}>No communications match.</Empty>}
            columns={[
              { header: "Person / item", cell: (c) => <PersonCell c={c} /> },
              { header: "Channel", cell: (c) => `${c.channel} · ${c.direction}` },
              { header: "Branch", cell: (c) => branchName(c.branch_id) },
              { header: "Message", cell: (c) => <Message c={c} /> },
              { header: "State", cell: (c) => <Status>{c.delivery_status}</Status> },
              { header: "Queue", cell: (c) => <Status>{c.queue}</Status> },
              { header: "SLA", cell: (c) => <SlaCell c={c} /> },
              { header: "When", cell: (c) => dateTime(c.occurred_at) },
              { header: "Action", cell: actions },
            ]}
          />
        </div>
        <div className="mobile-lead-list">
          {comms.isLoading ? (
            <LoadingRows />
          ) : comms.error ? (
            <ErrorPanel error={comms.error} onRetry={() => void comms.refetch()} />
          ) : rows?.length ? (
            rows.map((c) => (
              <div className="mobile-lead-card" key={c.communication_id}>
                <div className="flex items-start justify-between gap-3">
                  <PersonCell c={c} />
                  <Status>{c.queue}</Status>
                </div>
                <div className="my-2 space-y-1 text-xs">
                  <div>
                    {c.channel} · {c.direction} · {branchName(c.branch_id)} · {dateTime(c.occurred_at)}
                  </div>
                  <Message c={c} />
                  <SlaCell c={c} />
                </div>
                {actions(c)}
              </div>
            ))
          ) : (
            <Empty title={`Nothing in ${tab}`} />
          )}
        </div>
        <Pagination meta={comms.data?.meta} onPage={(page) => onSearch({ ...search, page })} />
      </div>
      <div className="mt-4">
        <Warning>Identity ambiguity never auto-merges and does not pause the lead SLA — possible matches wait in Match Review until someone confirms them.</Warning>
      </div>
      <LogCommunicationDialog open={logOpen} onOpenChange={setLogOpen} />
      <MatchDialog comm={matching} onClose={() => setMatching(null)} />
      <ReplyDialog comm={replying} onClose={() => setReplying(null)} />
    </>
  );
}

// ---------------------------------------------------------------- log

type LogValues = {
  branch_id: string;
  contact_channel_id: string;
  direction: "Inbound" | "Outbound";
  delivery_status: string;
  from_address: string;
  to_address: string;
  subject: string;
  body: string;
  call_duration_seconds: string;
  failure_reason: string;
  needs_response: boolean;
  response_due_at: string;
  occurred_at: string;
};

function LogCommunicationDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { branches, branchId } = useAuth();
  const defaults = (): LogValues => ({
    branch_id: String(branchId ?? (branches.length === 1 ? branches[0]!.branch_id : "")),
    contact_channel_id: "",
    direction: "Inbound",
    delivery_status: "Received",
    from_address: "",
    to_address: "",
    subject: "",
    body: "",
    call_duration_seconds: "",
    failure_reason: "",
    needs_response: true,
    response_due_at: "",
    occurred_at: "",
  });
  const form = useForm<LogValues>({ defaultValues: defaults() });
  const { register, handleSubmit, formState, reset, watch, setValue } = form;
  const direction = watch("direction");
  const status = watch("delivery_status");
  const needsResponse = watch("needs_response");

  useEffect(() => {
    if (open) reset(defaults());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const record = useApiMutation(communicationsApi.record, {
    success: (c) => `Communication logged${c.match_status === "Match Review" ? " — possible match sent to Match Review" : ""}`,
    invalidate,
    silentValidation: true,
    onSuccess: () => onOpenChange(false),
    onError: (error) => applyServerErrors(form, error),
  });

  const submit = handleSubmit((v) => {
    const body: NewCommunication = {
      branch_id: Number(v.branch_id),
      contact_channel_id: Number(v.contact_channel_id),
      direction: v.direction,
      delivery_status: v.delivery_status,
      from_address: v.from_address.trim() || null,
      to_address: v.to_address.trim() || null,
      subject: v.subject.trim() || null,
      body: v.body.trim() || null,
      call_duration_seconds: v.call_duration_seconds ? Number(v.call_duration_seconds) : null,
      failure_reason: v.delivery_status === "Failed" ? v.failure_reason.trim() || null : null,
      needs_response: v.needs_response,
      response_due_at: v.needs_response ? fromLocalInput(v.response_due_at) : null,
      occurred_at: fromLocalInput(v.occurred_at),
    };
    record.mutate(body);
  });
  const err = (name: keyof LogValues) => formState.errors[name]?.message;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] w-[calc(100vw-1.5rem)] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Log communication</DialogTitle>
          <DialogDescription>Record an inbound or outbound message or call. A sender that matches a known person goes to Match Review — never matched automatically.</DialogDescription>
        </DialogHeader>
        <form id="log-comm-form" onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
          <Field label="Branch" error={err("branch_id")} htmlFor="lc-branch">
            <BranchSelect id="lc-branch" {...register("branch_id", { required: "Required" })} />
          </Field>
          <Field label="Channel" error={err("contact_channel_id")} htmlFor="lc-channel">
            <LookupSelect id="lc-channel" lookup="contact_channels" {...register("contact_channel_id", { required: "Required" })} />
          </Field>
          <Field label="Direction" error={err("direction")} htmlFor="lc-direction">
            <NativeSelect
              id="lc-direction"
              options={[
                { value: "Inbound", label: "Inbound" },
                { value: "Outbound", label: "Outbound" },
              ]}
              {...register("direction", {
                onChange: (e) => {
                  const inbound = e.target.value === "Inbound";
                  setValue("needs_response", inbound);
                  setValue("delivery_status", inbound ? "Received" : "Sent");
                },
              })}
            />
          </Field>
          <Field label="Delivery status" error={err("delivery_status")} htmlFor="lc-status">
            <NativeSelect id="lc-status" options={DELIVERY_STATUSES.map((s) => ({ value: s, label: s }))} {...register("delivery_status")} />
          </Field>
          <Field label="From (phone / email)" error={err("from_address")} htmlFor="lc-from">
            <Input id="lc-from" {...register("from_address", { validate: (x) => direction !== "Inbound" || Boolean(x.trim()) || "Who sent it?" })} />
          </Field>
          <Field label="To (phone / email)" error={err("to_address")} htmlFor="lc-to">
            <Input id="lc-to" {...register("to_address", { validate: (x) => direction !== "Outbound" || Boolean(x.trim()) || "Who was it sent to?" })} />
          </Field>
          <Field label="Subject (optional)" error={err("subject")} htmlFor="lc-subject" className="sm:col-span-2">
            <Input id="lc-subject" {...register("subject")} />
          </Field>
          <Field label="Message" error={err("body")} htmlFor="lc-body" className="sm:col-span-2">
            <Textarea id="lc-body" rows={3} {...register("body")} />
          </Field>
          <Field label="Call duration (seconds, optional)" error={err("call_duration_seconds")} htmlFor="lc-duration">
            <Input id="lc-duration" type="number" min={0} {...register("call_duration_seconds")} />
          </Field>
          <Field label="Occurred at (optional, defaults to now)" error={err("occurred_at")} htmlFor="lc-occurred">
            <Input id="lc-occurred" type="datetime-local" {...register("occurred_at")} />
          </Field>
          {status === "Failed" && (
            <Field label="Failure reason" error={err("failure_reason")} htmlFor="lc-failure" className="sm:col-span-2">
              <Input id="lc-failure" {...register("failure_reason")} />
            </Field>
          )}
          <div className="field sm:col-span-2">
            <label className="flex items-center gap-2 text-sm font-normal text-foreground">
              <input type="checkbox" {...register("needs_response")} />
              Needs a response
            </label>
          </div>
          {needsResponse && (
            <Field label="Response due (optional)" hint="Defaults to the branch's staffed-hours response SLA" error={err("response_due_at")} htmlFor="lc-due">
              <Input id="lc-due" type="datetime-local" {...register("response_due_at")} />
            </Field>
          )}
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="log-comm-form" disabled={record.isPending}>
            Save communication
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- match

type PersonHit = Person & { open_leads?: { lead_id: number; lead_code: string; branch_code: string; course_code: string | null; stage: string }[] };

function MatchDialog({ comm, onClose }: { comm: Communication | null; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [personId, setPersonId] = useState<number | null>(null);
  const [leadId, setLeadId] = useState("");
  const address = comm ? (comm.direction === "Inbound" ? comm.from_address : comm.to_address) : null;

  useEffect(() => {
    if (comm) {
      const digits = (address ?? "").replace(/\D/g, "");
      const initial = address?.includes("@") ? address : digits.length >= 10 ? digits.slice(-10) : "";
      setQuery(initial);
      setSubmitted(initial || null);
      setPersonId(comm.person_id);
      setLeadId("");
    }
  }, [comm, address]);

  const searchKey = submitted ?? "";
  const params = searchKey.includes("@") ? { email: searchKey } : /^\+?\d[\d\s]{6,}$/.test(searchKey) ? { phone: searchKey.replace(/\s/g, "") } : { name: searchKey };
  const hits = useQuery({
    queryKey: ["persons", "search", params],
    queryFn: () => leadsApi.searchPersons(params) as Promise<PersonHit[]>,
    enabled: Boolean(comm && submitted),
  });
  const suggested = usePersonName(comm?.person_id ?? null);
  const people: PersonHit[] = [...(hits.data ?? [])];
  if (suggested.data && !people.some((p) => p.person_id === suggested.data.person_id)) people.unshift(suggested.data);
  const chosen = people.find((p) => p.person_id === personId);

  const match = useApiMutation((v: { person: number; lead: number | null }) => communicationsApi.match(comm!.communication_id, v.person, v.lead), {
    success: "Communication matched",
    invalidate,
    onSuccess: onClose,
  });

  return (
    <Dialog open={comm !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] w-[calc(100vw-1.5rem)] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Match communication</DialogTitle>
          <DialogDescription>
            {comm?.channel} · {comm?.direction} · {address ?? "unknown"} — confirm the person (and optionally the lead). Nothing is merged.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitted(query.trim() || null);
          }}
        >
          <Input aria-label="Search person" placeholder="Phone, email or name" value={query} onChange={(e) => setQuery(e.target.value)} />
          <Button type="submit" variant="outline">
            <Search />
            Search
          </Button>
        </form>
        <div className="space-y-2" role="radiogroup" aria-label="People">
          {hits.isFetching && <LoadingRows rows={2} />}
          {!hits.isFetching && people.length === 0 && <Empty title="No people found">Try another phone, email or name.</Empty>}
          {people.map((p) => (
            <label key={p.person_id} className="flex cursor-pointer items-start gap-2 rounded-md border p-3 text-sm">
              <input
                type="radio"
                name="match-person"
                className="mt-1"
                checked={personId === p.person_id}
                onChange={() => {
                  setPersonId(p.person_id);
                  setLeadId("");
                }}
              />
              <span className="min-w-0">
                <b>{p.full_name}</b> <span className="text-muted-foreground">{p.person_code}</span>
                {comm?.person_id === p.person_id && <Status kind="warn">Suggested</Status>}
                <span className="block text-xs text-muted-foreground">
                  {p.phone} {p.email ? `· ${p.email}` : ""}
                </span>
              </span>
            </label>
          ))}
        </div>
        {chosen && (
          <Field label="Lead (optional)" htmlFor="match-lead">
            <NativeSelect
              id="match-lead"
              value={leadId}
              placeholder="Person only — no lead"
              options={(chosen.open_leads ?? []).map((l) => ({ value: l.lead_id, label: `${l.lead_code} · ${l.course_code ?? "no course"} · ${l.stage}` }))}
              onChange={(e) => setLeadId(e.target.value)}
            />
          </Field>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!personId || match.isPending} onClick={() => match.mutate({ person: personId!, lead: leadId ? Number(leadId) : null })}>
            Confirm match
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- reply

function ReplyDialog({ comm, onClose }: { comm: Communication | null; onClose: () => void }) {
  const [body, setBody] = useState("");
  const [status, setStatus] = useState("Sent");
  useEffect(() => {
    if (comm) {
      setBody("");
      setStatus("Sent");
    }
  }, [comm]);
  const reply = useApiMutation((v: { body: string; status: string }) => communicationsApi.reply(comm!.communication_id, { body: v.body, delivery_status: v.status }), {
    success: "Reply logged",
    invalidate,
    onSuccess: onClose,
  });
  return (
    <Dialog open={comm !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[calc(100vw-1.5rem)] max-w-lg">
        <DialogHeader>
          <DialogTitle>Reply</DialogTitle>
          <DialogDescription>
            Log the reply sent to {comm?.from_address ?? "the sender"} on {comm?.channel}. The original is marked responded.
          </DialogDescription>
        </DialogHeader>
        {comm?.body && <blockquote className="rounded-md border bg-muted/40 p-3 text-sm">{comm.body}</blockquote>}
        <Field label="Reply message" htmlFor="reply-body">
          <Textarea id="reply-body" rows={3} value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
        <Field label="Delivery status" htmlFor="reply-status">
          <NativeSelect id="reply-status" value={status} options={["Sent", "Delivered", "Read", "Failed"].map((s) => ({ value: s, label: s }))} onChange={(e) => setStatus(e.target.value)} />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!body.trim() || reply.isPending} onClick={() => reply.mutate({ body: body.trim(), status })}>
            Log reply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
