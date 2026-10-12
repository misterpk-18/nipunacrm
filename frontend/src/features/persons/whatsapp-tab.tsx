/** Person 360 → WhatsApp tab: the number, the learner's marketing consent and the conversation. */
import { useState } from "react";
import { consentTone, problemOf, usePersonWhatsapp, type ConversationItem, type MarketingTemplate, type OutboundItem, type WhatsappMessage } from "@/api/whatsapp";
import { Button } from "@/components/ui/button";
import { Empty, ErrorPanel, Facts, LoadingRows, Section, Status } from "@/components/crm/ui";
import { ConsentDialog, RetryButton, RetryDialog, StatusChip, useCanRecordConsent, useTemplateCatalogue } from "@/features/operations/whatsapp-shared";
import { dateTime, phone } from "@/lib/format";

export function WhatsappTab({ personId }: { personId: number }) {
  const conversation = usePersonWhatsapp(personId);
  const templates = useTemplateCatalogue();
  const canConsent = useCanRecordConsent();
  const [consent, setConsent] = useState<null | "Explicit Consent" | "Withdrawn">(null);
  const [retrying, setRetrying] = useState<WhatsappMessage | null>(null);
  if (conversation.isLoading) return <LoadingRows rows={4} />;
  if (conversation.error) return <ErrorPanel error={conversation.error} onRetry={() => void conversation.refetch()} />;
  const { whatsapp_number, consent: c, messages, notifications } = conversation.data!;
  const labelFor = (name: string) => templateLabel(templates, name);

  return (
    <div className="grid gap-4">
      <Section title="Consent" subtitle="Marketing templates are sent only with explicit consent. Service messages do not need it.">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Status kind={notifications ? "good" : "danger"}>{notifications ? "Notifications on" : "Notifications off"}</Status>
          <Status kind={consentTone(c.status)}>{c.status}</Status>
          {c.at && <span className="text-sm text-muted-foreground">{dateTime(c.at)}</span>}
        </div>
        <Facts
          columns={2}
          items={[
            ["WhatsApp number", whatsapp_number ? phone(whatsapp_number) : "None on file"],
            ["Source", c.source ?? "—"],
            ["Recorded by", c.by ? `User #${c.by}` : "—"],
          ]}
        />
        {canConsent && (
          <div className="mt-3 flex flex-wrap gap-2">
            {c.status !== "Explicit Consent" && <Button size="sm" onClick={() => setConsent("Explicit Consent")}>Record consent</Button>}
            {c.status === "Explicit Consent" && (
              <Button size="sm" variant="outline" onClick={() => setConsent("Explicit Consent")}>
                Update consent
              </Button>
            )}
            {c.status !== "Withdrawn" && (
              <Button size="sm" variant="outline" className="text-destructive" onClick={() => setConsent("Withdrawn")}>
                Withdraw
              </Button>
            )}
          </div>
        )}
      </Section>
      <Section title="Conversation" subtitle="Newest first. Messages show exactly what the learner received.">
        {messages.length === 0 ? (
          <Empty title="No WhatsApp messages yet">Messages sent to or received from this learner appear here.</Empty>
        ) : (
          <ul className="grid gap-3">
            {messages.map((m) => (
              <li key={m.direction === "Outbound" ? `o${m.outbox_id}` : `i${m.communication_id}`}>
                {m.direction === "Outbound" ? <Outbound item={m} label={labelFor(m.template_name)} onRetry={setRetrying} /> : <Inbound item={m} />}
              </li>
            ))}
          </ul>
        )}
      </Section>
      {consent && <ConsentDialog personId={personId} mode={consent} onClose={() => setConsent(null)} />}
      {retrying && <RetryDialog message={retrying} onClose={() => setRetrying(null)} />}
    </div>
  );
}

/** Template label from the marketing catalogue when it is one, else the template name made readable. */
export function templateLabel(templates: MarketingTemplate[] | undefined, name: string): string {
  const found = templates?.find((t) => t.template_name === name);
  if (found) return found.label;
  const text = name.replace(/^nipuna_/, "").replace(/_(u|mkt)_v\d+$/, "").replace(/_/g, " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function Outbound({ item, label, onRetry }: { item: OutboundItem; label: string; onRetry: (m: WhatsappMessage) => void }) {
  const problem = problemOf(item);
  const times = [
    item.sent_at && `Sent ${dateTime(item.sent_at)}`,
    item.delivered_at && `Delivered ${dateTime(item.delivered_at)}`,
    item.read_at && `Read ${dateTime(item.read_at)}`,
  ].filter(Boolean);
  return (
    <div className="ml-auto max-w-[92%] rounded-lg border p-3 sm:max-w-[80%]" style={{ background: "color-mix(in srgb, var(--whatsapp) 12%, white)" }}>
      <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-semibold text-foreground">{label}</span>
        <Status kind={item.category === "Marketing" ? "info" : "neutral"}>{item.category}</Status>
        <StatusChip status={item.status} />
      </div>
      <p className="whitespace-pre-wrap break-words text-sm">{item.body_text}</p>
      {problem && <p className="mt-2 break-words text-xs text-destructive">{problem}</p>}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{times.length ? times.join(" · ") : `Created ${dateTime(item.created_at)}`}</span>
        <RetryButton message={item} onRetry={onRetry} />
      </div>
    </div>
  );
}

function Inbound({ item }: { item: Extract<ConversationItem, { direction: "Inbound" }> }) {
  return (
    <div className="mr-auto max-w-[92%] rounded-lg border bg-card p-3 sm:max-w-[80%]">
      <div className="mb-1 text-xs text-muted-foreground">Reply from learner</div>
      <p className="whitespace-pre-wrap break-words text-sm">{item.body_text ?? "(no text)"}</p>
      <div className="mt-2 text-xs text-muted-foreground">{dateTime(item.at)}</div>
    </div>
  );
}
