/** "Send template" (Lead 360) and "Send now" (Person 360): a counsellor sends one approved WhatsApp template to the learner. */
import { useState } from "react";
import { ApiError } from "@/api/client";
import type { Lead, Person } from "@/api/leads";
import { consentTone, useMarketingTemplates, whatsappApi, whatsappInvalidate, type ConsentStatus, type MarketingSend } from "@/api/whatsapp";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { CourseSelect, Field, NativeSelect } from "@/components/crm/forms";
import { ErrorPanel, LoadingRows, Status } from "@/components/crm/ui";
import { ConsentDialog } from "@/features/operations/whatsapp-shared";
import { useApiMutation } from "@/lib/mutation";

type Target = {
  personId: number;
  name: string;
  consent: ConsentStatus;
  notifications: boolean;
  course: { course_title: string } | null;
  interest: string;
  send: (body: MarketingSend) => Promise<unknown>;
  invalidate: string[][];
};

export function SendTemplateDialog({ lead, onClose }: { lead: Lead; onClose: () => void }) {
  return (
    <TemplateDialog
      onClose={onClose}
      target={{
        personId: lead.person.person_id,
        name: lead.person.full_name,
        consent: lead.person.whatsapp_consent?.status ?? "Not Recorded",
        notifications: lead.person.whatsapp_notifications ?? true,
        course: lead.course,
        interest: lead.need.learner_goal ?? "",
        send: (body) => whatsappApi.sendMarketing(lead.lead_id, body),
        invalidate: [["leads"]],
      }}
    />
  );
}

/** Person 360 → Send now: the same dialog, sent through the person's most recent enquiry. */
export function SendNowDialog({ person, course, onClose }: { person: Person; course: { course_title: string } | null; onClose: () => void }) {
  return (
    <TemplateDialog
      onClose={onClose}
      target={{
        personId: person.person_id,
        name: person.full_name,
        consent: person.whatsapp_consent?.status ?? "Not Recorded",
        notifications: person.whatsapp_notifications ?? true,
        course,
        interest: "",
        send: (body) => whatsappApi.sendToPerson(person.person_id, body),
        invalidate: [["leads"]],
      }}
    />
  );
}

function TemplateDialog({ target, onClose }: { target: Target; onClose: () => void }) {
  const templates = useMarketingTemplates();
  const [key, setKey] = useState("");
  const [courseId, setCourseId] = useState("");
  const [interest, setInterest] = useState(target.interest);
  const [serverError, setServerError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const consent = target.consent;
  const hasConsent = consent === "Explicit Consent";
  const template = templates.data?.find((t) => t.key === key);
  const needsCourse = !!template?.needs.includes("course") && !target.course;
  const needsInterest = !!template?.needs.includes("interest");
  const ready = !!template && target.notifications && hasConsent && (!needsCourse || courseId !== "") && (!needsInterest || interest.trim() !== "");
  const switchOn = useApiMutation(() => whatsappApi.setNotifications(target.personId, true), {
    success: "WhatsApp notifications switched on",
    invalidate: whatsappInvalidate(target.personId),
  });

  const send = useApiMutation(
    () =>
      target.send({
        template: key,
        ...(courseId ? { course_id: Number(courseId) } : {}),
        ...(needsInterest && interest.trim() ? { interest: interest.trim() } : {}),
      }),
    {
      success: "Template queued. It will be sent to the learner shortly.",
      invalidate: [...whatsappInvalidate(target.personId), ...target.invalidate],
      onSuccess: onClose,
      // The server's message is shown in the dialog; the toast would repeat it.
      onError: (e) => setServerError(e instanceof ApiError || e instanceof Error ? e.message : "Could not send the template"),
    },
  );

  return (
    <>
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Send template</DialogTitle>
            <DialogDescription>Send an approved WhatsApp message to {target.name}.</DialogDescription>
          </DialogHeader>
          {templates.isLoading ? (
            <LoadingRows rows={3} />
          ) : templates.error ? (
            <ErrorPanel error={templates.error} onRetry={() => void templates.refetch()} />
          ) : (
            <form
              id="send-template-form"
              className="grid gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                setServerError(null);
                send.mutate(undefined);
              }}
            >
              {!target.notifications && (
                <div className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 p-3 text-sm">
                  <p className="basis-full text-muted-foreground">WhatsApp notifications are switched off for this learner, so nothing can be sent.</p>
                  <Button type="button" size="sm" variant="outline" disabled={switchOn.isPending} onClick={() => switchOn.mutate(undefined)}>
                    Switch on
                  </Button>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2 rounded-md border p-3 text-sm">
                <span className="text-muted-foreground">WhatsApp marketing consent</span>
                <Status kind={consentTone(consent)}>{consent}</Status>
                {!hasConsent && (
                  <>
                    <p className="basis-full text-muted-foreground">
                      {consent === "Withdrawn" ? "The learner withdrew consent." : "Consent has not been recorded."} Marketing templates can be sent only with explicit consent.
                    </p>
                    <Button type="button" size="sm" variant="outline" onClick={() => setRecording(true)}>
                      Record consent
                    </Button>
                  </>
                )}
              </div>
              <Field label="Template" htmlFor="tpl-key" hint={template?.about}>
                <NativeSelect
                  id="tpl-key"
                  value={key}
                  placeholder="Select a template…"
                  options={(templates.data ?? []).map((t) => ({ value: t.key, label: t.label }))}
                  onChange={(e) => {
                    setKey(e.target.value);
                    setServerError(null);
                  }}
                />
              </Field>
              {template && (
                <>
                  <Field label="Course" htmlFor="tpl-course" hint={target.course ? `Uses the course on their latest enquiry: ${target.course.course_title}` : undefined}>
                    {target.course && !courseId ? (
                      <Input id="tpl-course" value={target.course.course_title} readOnly />
                    ) : (
                      <CourseSelect id="tpl-course" value={courseId} onChange={(e) => setCourseId(e.target.value)} />
                    )}
                  </Field>
                  {needsInterest && (
                    <Field label="Interest" htmlFor="tpl-interest" hint="What the learner said they are interested in">
                      <Input id="tpl-interest" maxLength={200} value={interest} onChange={(e) => setInterest(e.target.value)} />
                    </Field>
                  )}
                  {template.reply_keywords.length > 0 && (
                    <p className="text-xs text-muted-foreground">The learner can reply: {template.reply_keywords.join(", ")}.</p>
                  )}
                </>
              )}
              {serverError && (
                <p className="text-sm text-destructive" role="alert">
                  {serverError}
                </p>
              )}
            </form>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" form="send-template-form" disabled={!ready || send.isPending}>
              Send
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {recording && <ConsentDialog personId={target.personId} mode="Explicit Consent" onClose={() => setRecording(false)} />}
    </>
  );
}
