/** Offer Master: versioned offers, scope, complimentary courses, activation. Read-only for branch managers. */
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { Copy, Pencil, Plus, Power, PowerOff, Trash2 } from "lucide-react";
import {
  OFFER_BENEFIT_TYPES,
  OFFER_STATUSES,
  offerKeys,
  offersApi,
  useOffer,
  useOffers,
  type ComplimentaryInput,
  type Offer,
  type OfferFields,
} from "@/api/offers";
import { useBranches, useCourses } from "@/api/reference";
import { useAuth } from "@/auth/auth";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, NativeSelect, applyServerErrors } from "@/components/crm/forms";
import {
  ConfirmAction,
  DataTable,
  Empty,
  ErrorPanel,
  Facts,
  LoadingRows,
  PageHead,
  Section,
  Status,
  Warning,
} from "@/components/crm/ui";
import { date, dateTime, money } from "@/lib/format";
import { useApiMutation } from "@/lib/mutation";

const EDITABLE = ["Draft", "Configured"];

function benefitText(o: Offer) {
  if (o.benefit_type === "Discount Amount")
    return `${money(o.discount_amount)} off`;
  if (o.benefit_type === "Discount Percent")
    return `${Number(o.discount_percent ?? 0)}% off`;
  return `Complimentary course (${o.complimentary_courses.length})`;
}

export function OfferMasterPage() {
  const { isAdmin } = useAuth();
  const [status, setStatus] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const offers = useOffers({ status: status || undefined });
  const branches = useBranches();
  const branchNames = (o: Offer) =>
    o.applies_to_all_branches
      ? "All branches"
      : o.branch_ids
          .map(
            (id) =>
              branches.data?.find((b) => b.branch_id === id)?.branch_name ?? id,
          )
          .join(", ");
  const anyActive = offers.data?.some((o) => o.status === "Active");

  return (
    <>
      <PageHead
        title="Offer Master"
        description={
          isAdmin
            ? "Versioned and auditable · editing an active offer means creating a new version"
            : "Read-only · offers are configured by Founder / Super Admin"
        }
        actions={
          isAdmin && (
            <Button onClick={() => setCreating(true)}>
              <Plus />
              New offer
            </Button>
          )
        }
      />
      {offers.data && !status && !anyActive && (
        <div className="mb-4">
          <Warning>
            No offer is active. Threshold alone never grants a complimentary
            course — an active Offer Master version is required.
          </Warning>
        </div>
      )}
      <Section
        title="Offer versions"
        action={
          <NativeSelect
            aria-label="Status filter"
            className="h-8 w-40"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            placeholder="All statuses"
            options={OFFER_STATUSES.map((s) => ({ value: s, label: s }))}
          />
        }
      >
        <DataTable
          rows={offers.data}
          loading={offers.isLoading}
          error={offers.error}
          onRetry={() => void offers.refetch()}
          rowKey={(o) => o.offer_id}
          onRowClick={(o) => setSelected(o.offer_id)}
          empty={
            <Empty title="No offers yet">
              {isAdmin ? "Create the first offer version." : undefined}
            </Empty>
          }
          columns={[
            {
              header: "Version",
              cell: (o) => (
                <button
                  type="button"
                  className="text-left font-semibold text-primary"
                  onClick={() => setSelected(o.offer_id)}
                >
                  {o.offer_code} · v{o.version}
                  <small className="block font-normal text-muted-foreground">
                    {o.offer_name}
                  </small>
                </button>
              ),
            },
            { header: "Status", cell: (o) => <Status>{o.status}</Status> },
            {
              header: "Branch / course scope",
              cell: (o) =>
                `${branchNames(o)} · ${o.applies_to_all_courses ? "all courses" : `${o.courses.length} course(s)`}`,
            },
            {
              header: "Dates",
              cell: (o) =>
                o.valid_from
                  ? `${date(o.valid_from)} – ${date(o.valid_to)}`
                  : "Not set",
            },
            { header: "Benefit", cell: benefitText },
            {
              header: "Combination",
              cell: (o) =>
                o.allows_stacking ? "Stacking allowed" : "No stacking",
            },
            {
              header: "Qualifying payment",
              cell: (o) => o.qualifying_payment_rule ?? "—",
            },
            {
              header: "Approved",
              cell: (o) => (o.approved_at ? dateTime(o.approved_at) : "—"),
            },
          ]}
        />
      </Section>
      {selected !== null && (
        <OfferDetail
          id={selected}
          onSelect={setSelected}
          branchNames={branchNames}
        />
      )}
      {isAdmin && (
        <OfferFormDialog
          open={creating}
          onOpenChange={setCreating}
          onCreated={(o) => setSelected(o.offer_id)}
        />
      )}
    </>
  );
}

function OfferDetail({
  id,
  onSelect,
  branchNames,
}: {
  id: number;
  onSelect: (id: number) => void;
  branchNames: (o: Offer) => string;
}) {
  const { isAdmin } = useAuth();
  const offer = useOffer(id);
  const [dialog, setDialog] = useState<
    null | "edit" | "scope" | "complimentary"
  >(null);
  const invalidate = [offerKeys.all];
  const activate = useApiMutation(() => offersApi.activate(id), {
    success: (o) => `${o.offer_code} v${o.version} is active`,
    invalidate,
  });
  const deactivate = useApiMutation(() => offersApi.deactivate(id), {
    success: (o) => `${o.offer_code} v${o.version} deactivated`,
    invalidate,
  });
  const newVersion = useApiMutation(() => offersApi.newVersion(id), {
    success: (o) => `Draft v${o.version} created`,
    invalidate,
    onSuccess: (o) => onSelect(o.offer_id),
  });

  if (offer.isLoading)
    return (
      <Section title="Offer" className="mt-4">
        <LoadingRows rows={4} />
      </Section>
    );
  if (offer.error)
    return (
      <Section title="Offer" className="mt-4">
        <ErrorPanel error={offer.error} onRetry={() => void offer.refetch()} />
      </Section>
    );
  const o = offer.data!;
  const editable = EDITABLE.includes(o.status);

  return (
    <Section
      title={`${o.offer_code} · v${o.version} · ${o.offer_name}`}
      subtitle={<Status>{o.status}</Status>}
      className="mt-4"
      action={
        isAdmin && (
          <div className="flex flex-wrap gap-2">
            {editable && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setDialog("edit")}
                >
                  <Pencil />
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setDialog("scope")}
                >
                  Scope
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setDialog("complimentary")}
                >
                  Complimentary courses
                </Button>
              </>
            )}
            {o.status !== "Active" && o.status !== "Expired" && (
              <ConfirmAction
                trigger={
                  <Button size="sm">
                    <Power />
                    Activate
                  </Button>
                }
                title={`Activate ${o.offer_code} v${o.version}?`}
                description="Any other active version of this offer is deactivated. Counsellors can apply it immediately."
                action="Activate"
                onConfirm={() => activate.mutateAsync(undefined)}
              />
            )}
            {o.status === "Active" && (
              <ConfirmAction
                trigger={
                  <Button size="sm" variant="destructive">
                    <PowerOff />
                    Deactivate
                  </Button>
                }
                title={`Deactivate ${o.offer_code} v${o.version}?`}
                action="Deactivate"
                destructive
                onConfirm={() => deactivate.mutateAsync(undefined)}
              />
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => newVersion.mutate(undefined)}
              disabled={newVersion.isPending}
            >
              <Copy />
              New version
            </Button>
          </div>
        )
      }
    >
      <Facts
        columns={3}
        items={[
          ["Benefit", benefitText(o)],
          [
            "Validity",
            o.valid_from
              ? `${date(o.valid_from)} – ${date(o.valid_to)}`
              : "Not set",
          ],
          [
            "Combination",
            o.allows_stacking
              ? "Stacking allowed"
              : "No stacking unless approved",
          ],
          ["Branches", branchNames(o)],
          [
            "Courses",
            o.applies_to_all_courses
              ? "All courses"
              : o.courses.map((c) => c.course_title).join(", ") ||
                "None selected",
          ],
          ["Qualifying payment", o.qualifying_payment_rule ?? "—"],
          ["Description", o.description ?? "—"],
          ["Created", dateTime(o.created_at)],
          ["Approved", o.approved_at ? dateTime(o.approved_at) : "—"],
        ]}
      />
      <h3 className="mb-2 mt-5 text-sm font-semibold">
        Complimentary eligibility
      </h3>
      <DataTable
        rows={o.complimentary_courses}
        rowKey={(c) => c.course_id}
        empty={<Empty title="No complimentary courses" />}
        columns={[
          {
            header: "Course",
            cell: (c) => `${c.course_code} · ${c.course_title}`,
          },
          {
            header: "Threshold",
            cell: (c) => `Final agreed paid fee ≥ ${money(c.min_final_fee)}`,
          },
          {
            header: "Access period",
            cell: (c) =>
              c.access_period_days ? `${c.access_period_days} days` : "—",
          },
        ]}
      />
      <p className="mt-3 text-xs text-muted-foreground">
        Threshold alone never grants access; an active Offer Master version is
        required.
      </p>
      {isAdmin && editable && (
        <>
          <OfferFormDialog
            open={dialog === "edit"}
            onOpenChange={(v) => setDialog(v ? "edit" : null)}
            offer={o}
          />
          <ScopeDialog
            open={dialog === "scope"}
            onOpenChange={(v) => setDialog(v ? "scope" : null)}
            offer={o}
          />
          <ComplimentaryDialog
            open={dialog === "complimentary"}
            onOpenChange={(v) => setDialog(v ? "complimentary" : null)}
            offer={o}
          />
        </>
      )}
    </Section>
  );
}

type OfferValues = {
  offer_code: string;
  offer_name: string;
  description: string;
  benefit_type: string;
  discount_amount: string;
  discount_percent: string;
  allows_stacking: boolean;
  qualifying_payment_rule: string;
  valid_from: string;
  valid_to: string;
  status: "Draft" | "Configured";
  applies_to_all_branches: boolean;
  applies_to_all_courses: boolean;
};

function OfferFormDialog({
  open,
  onOpenChange,
  offer,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  offer?: Offer;
  onCreated?: (o: Offer) => void;
}) {
  const defaults = (): OfferValues => ({
    offer_code: offer?.offer_code ?? "",
    offer_name: offer?.offer_name ?? "",
    description: offer?.description ?? "",
    benefit_type: offer?.benefit_type ?? "Discount Amount",
    discount_amount: offer?.discount_amount ?? "",
    discount_percent: offer?.discount_percent ?? "",
    allows_stacking: offer?.allows_stacking ?? false,
    qualifying_payment_rule:
      offer?.qualifying_payment_rule ?? "First allocated payment Verified",
    valid_from: offer?.valid_from ?? "",
    valid_to: offer?.valid_to ?? "",
    status: (offer?.status as "Draft" | "Configured") ?? "Draft",
    applies_to_all_branches: offer?.applies_to_all_branches ?? true,
    applies_to_all_courses: offer?.applies_to_all_courses ?? true,
  });
  const form = useForm<OfferValues>({ defaultValues: defaults() });
  const { register, handleSubmit, watch, formState, reset } = form;
  useEffect(() => {
    if (open) reset(defaults());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, offer?.offer_id]);
  const benefit = watch("benefit_type");
  const opts = {
    invalidate: [offerKeys.all],
    silentValidation: true,
    onError: (e: unknown) => applyServerErrors(form, e),
  };
  const create = useApiMutation(offersApi.create, {
    ...opts,
    success: (o) => `${o.offer_code} v${o.version} created`,
    onSuccess: (o) => {
      onOpenChange(false);
      onCreated?.(o);
    },
  });
  const update = useApiMutation(
    (body: OfferFields) => offersApi.update(offer!.offer_id, body),
    {
      ...opts,
      success: "Offer updated",
      onSuccess: () => onOpenChange(false),
    },
  );
  const submit = handleSubmit((v) => {
    const fields: OfferFields = {
      offer_name: v.offer_name.trim(),
      description: v.description || null,
      benefit_type: v.benefit_type,
      discount_amount:
        v.benefit_type === "Discount Amount" ? v.discount_amount || null : null,
      discount_percent:
        v.benefit_type === "Discount Percent"
          ? v.discount_percent || null
          : null,
      allows_stacking: v.allows_stacking,
      qualifying_payment_rule: v.qualifying_payment_rule || null,
      valid_from: v.valid_from || null,
      valid_to: v.valid_to || null,
      status: v.status,
    };
    if (offer) update.mutate(fields);
    else
      create.mutate({
        ...fields,
        offer_code: v.offer_code.trim(),
        applies_to_all_branches: v.applies_to_all_branches,
        applies_to_all_courses: v.applies_to_all_courses,
      });
  });
  const err = (k: keyof OfferValues) => formState.errors[k]?.message;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] w-[calc(100vw-1.5rem)] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {offer ? `Edit ${offer.offer_code} v${offer.version}` : "New offer"}
          </DialogTitle>
          <DialogDescription>
            Activation is a separate step and needs dates (and complimentary
            courses for that benefit type).
          </DialogDescription>
        </DialogHeader>
        <form
          id="offer-form"
          onSubmit={submit}
          className="grid gap-3 sm:grid-cols-2"
        >
          {!offer && (
            <Field
              label="Offer code"
              htmlFor="of-code"
              error={err("offer_code")}
              hint="e.g. OM-2026-10"
            >
              <Input
                id="of-code"
                {...register("offer_code", { required: "Required" })}
              />
            </Field>
          )}
          <Field label="Offer name" htmlFor="of-name" error={err("offer_name")}>
            <Input
              id="of-name"
              {...register("offer_name", { required: "Required" })}
            />
          </Field>
          <Field
            label="Benefit type"
            htmlFor="of-benefit"
            error={err("benefit_type")}
          >
            <NativeSelect
              id="of-benefit"
              options={OFFER_BENEFIT_TYPES.map((b) => ({ value: b, label: b }))}
              {...register("benefit_type")}
            />
          </Field>
          {benefit === "Discount Amount" && (
            <Field
              label="Discount amount (₹)"
              htmlFor="of-amount"
              error={err("discount_amount")}
            >
              <Input
                id="of-amount"
                inputMode="decimal"
                {...register("discount_amount", { required: "Required" })}
              />
            </Field>
          )}
          {benefit === "Discount Percent" && (
            <Field
              label="Discount percent"
              htmlFor="of-percent"
              error={err("discount_percent")}
            >
              <Input
                id="of-percent"
                inputMode="decimal"
                {...register("discount_percent", { required: "Required" })}
              />
            </Field>
          )}
          <Field label="Valid from" htmlFor="of-from" error={err("valid_from")}>
            <Input id="of-from" type="date" {...register("valid_from")} />
          </Field>
          <Field label="Valid to" htmlFor="of-to" error={err("valid_to")}>
            <Input id="of-to" type="date" {...register("valid_to")} />
          </Field>
          <Field
            label="Qualifying payment rule"
            htmlFor="of-rule"
            error={err("qualifying_payment_rule")}
          >
            <Input id="of-rule" {...register("qualifying_payment_rule")} />
          </Field>
          <Field
            label="Configuration status"
            htmlFor="of-status"
            error={err("status")}
          >
            <NativeSelect
              id="of-status"
              options={[
                { value: "Draft", label: "Draft" },
                { value: "Configured", label: "Configured" },
              ]}
              {...register("status")}
            />
          </Field>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" {...register("allows_stacking")} />
            Allows stacking with other offers
          </label>
          {!offer && (
            <>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  {...register("applies_to_all_courses")}
                />
                Applies to all courses
              </label>
            </>
          )}
          <Field
            label="Description"
            htmlFor="of-desc"
            className="sm:col-span-2"
          >
            <Textarea id="of-desc" {...register("description")} />
          </Field>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="offer-form"
            disabled={create.isPending || update.isPending}
          >
            {offer ? "Save changes" : "Create offer"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ScopeDialog({
  open,
  onOpenChange,
  offer,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  offer: Offer;
}) {
  const branches = useBranches();
  const courses = useCourses();
  const [allBranches, setAllBranches] = useState(offer.applies_to_all_branches);
  const [branchIds, setBranchIds] = useState<number[]>(offer.branch_ids);
  const [allCourses, setAllCourses] = useState(offer.applies_to_all_courses);
  const [courseIds, setCourseIds] = useState<number[]>(
    offer.courses.map((c) => c.course_id),
  );
  useEffect(() => {
    if (open) {
      setAllBranches(offer.applies_to_all_branches);
      setBranchIds(offer.branch_ids);
      setAllCourses(offer.applies_to_all_courses);
      setCourseIds(offer.courses.map((c) => c.course_id));
    }
  }, [open, offer]);
  const save = useApiMutation(
    () =>
      offersApi.setScope(offer.offer_id, {
        applies_to_all_branches: allBranches,
        branch_ids: allBranches ? [] : branchIds,
        applies_to_all_courses: allCourses,
        course_ids: allCourses ? [] : courseIds,
      }),
    {
      success: "Scope saved",
      invalidate: [offerKeys.all],
      onSuccess: () => onOpenChange(false),
    },
  );
  const toggle = (list: number[], id: number) =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] w-[calc(100vw-1.5rem)] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Offer scope</DialogTitle>
          <DialogDescription>
            Which branches and courses this version applies to.
          </DialogDescription>
        </DialogHeader>
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-semibold">Branches</legend>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={allBranches}
              onChange={(e) => setAllBranches(e.target.checked)}
            />
            All branches
          </label>
          {!allBranches &&
            branches.data?.map((b) => (
              <label
                key={b.branch_id}
                className="ml-5 flex items-center gap-2 text-sm"
              >
                <input
                  type="checkbox"
                  checked={branchIds.includes(b.branch_id)}
                  onChange={() => setBranchIds(toggle(branchIds, b.branch_id))}
                />
                {b.branch_name}
              </label>
            ))}
        </fieldset>
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-semibold">Courses</legend>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={allCourses}
              onChange={(e) => setAllCourses(e.target.checked)}
            />
            All courses
          </label>
          {!allCourses &&
            courses.data?.map((c) => (
              <label
                key={c.course_id}
                className="ml-5 flex items-center gap-2 text-sm"
              >
                <input
                  type="checkbox"
                  checked={courseIds.includes(c.course_id)}
                  onChange={() => setCourseIds(toggle(courseIds, c.course_id))}
                />
                {c.course_title} ({c.course_code})
              </label>
            ))}
        </fieldset>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => save.mutate(undefined)}
            disabled={save.isPending}
          >
            Save scope
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type CompRow = {
  course_id: string;
  min_final_fee: string;
  access_period_days: string;
};

function ComplimentaryDialog({
  open,
  onOpenChange,
  offer,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  offer: Offer;
}) {
  const courses = useCourses();
  const initial = (): CompRow[] =>
    offer.complimentary_courses.map((c) => ({
      course_id: String(c.course_id),
      min_final_fee: c.min_final_fee,
      access_period_days: c.access_period_days
        ? String(c.access_period_days)
        : "",
    }));
  const [rows, setRows] = useState<CompRow[]>(initial);
  useEffect(() => {
    if (open) setRows(initial());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, offer]);
  const save = useApiMutation(
    (list: ComplimentaryInput[]) =>
      offersApi.setComplimentary(offer.offer_id, list),
    {
      success: "Complimentary courses saved",
      invalidate: [offerKeys.all],
      onSuccess: () => onOpenChange(false),
    },
  );
  const set = (i: number, patch: Partial<CompRow>) =>
    setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const options = (courses.data ?? []).map((c) => ({
    value: c.course_id,
    label: `${c.course_title} (${c.course_code})`,
  }));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] w-[calc(100vw-1.5rem)] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Complimentary courses</DialogTitle>
          <DialogDescription>
            A free course when the final agreed paid fee reaches the threshold.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {rows.map((r, i) => (
            <div
              key={i}
              className="grid gap-2 rounded-md border p-3 sm:grid-cols-[1fr_140px_120px_auto] sm:items-end"
            >
              <Field label="Course" htmlFor={`cc-course-${i}`}>
                <NativeSelect
                  id={`cc-course-${i}`}
                  placeholder="Select course…"
                  options={options}
                  value={r.course_id}
                  onChange={(e) => set(i, { course_id: e.target.value })}
                />
              </Field>
              <Field label="Min final fee (₹)" htmlFor={`cc-fee-${i}`}>
                <Input
                  id={`cc-fee-${i}`}
                  inputMode="decimal"
                  value={r.min_final_fee}
                  onChange={(e) => set(i, { min_final_fee: e.target.value })}
                />
              </Field>
              <Field label="Access days" htmlFor={`cc-days-${i}`}>
                <Input
                  id={`cc-days-${i}`}
                  type="number"
                  min={1}
                  value={r.access_period_days}
                  onChange={(e) =>
                    set(i, { access_period_days: e.target.value })
                  }
                />
              </Field>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Remove course ${i + 1}`}
                onClick={() => setRows(rows.filter((_, j) => j !== i))}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setRows([
                ...rows,
                { course_id: "", min_final_fee: "0", access_period_days: "" },
              ])
            }
          >
            <Plus />
            Add course
          </Button>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={save.isPending || rows.some((r) => !r.course_id)}
            onClick={() =>
              save.mutate(
                rows.map((r) => ({
                  course_id: Number(r.course_id),
                  min_final_fee: r.min_final_fee || "0",
                  access_period_days: r.access_period_days
                    ? Number(r.access_period_days)
                    : null,
                })),
              )
            }
          >
            Save courses
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
