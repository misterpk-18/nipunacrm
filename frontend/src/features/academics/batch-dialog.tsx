import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { useNavigate } from "@tanstack/react-router";
import { DELIVERY_MODES } from "@/api/admissions";
import { BATCH_STATUSES, batchKeys, batchesApi, useCurriculumVersions, type Batch, type BatchBody } from "@/api/batches";
import { useCourses } from "@/api/reference";
import { useAuth } from "@/auth/auth";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { BranchSelect, Field, NativeSelect, StaffSelect, applyServerErrors, useBranchCode } from "@/components/crm/forms";
import { useApiMutation } from "@/lib/mutation";
import { admissionKeys } from "@/api/admissions";

type Values = {
  batch_name: string;
  branch_id: string;
  course_id: string;
  curriculum_version_id: string;
  delivery_mode: string;
  trainer_user_id: string;
  schedule_days: string;
  start_time: string;
  end_time: string;
  start_date: string;
  end_date: string;
  capacity: string;
  min_students: string;
  location: string;
  status: string;
  lms_course_id: string;
};

const fromBatch = (b: Batch): Values => ({
  batch_name: b.batch_name,
  branch_id: String(b.branch.branch_id),
  course_id: String(b.course.course_id),
  curriculum_version_id: b.curriculum_version ? String(b.curriculum_version.curriculum_version_id) : "",
  delivery_mode: b.delivery_mode,
  trainer_user_id: b.trainer ? String(b.trainer.user_id) : "",
  schedule_days: b.schedule_days ?? "",
  start_time: b.start_time ?? "",
  end_time: b.end_time ?? "",
  start_date: b.start_date,
  end_date: b.end_date ?? "",
  capacity: String(b.capacity),
  min_students: b.min_students ? String(b.min_students) : "",
  location: b.location ?? "",
  status: b.status,
  lms_course_id: b.lms_course_id ?? "",
});

/** Create a batch (Academic Coordinator / Branch Manager) or edit one. */
export function BatchDialog({ open, onOpenChange, batch }: { open: boolean; onOpenChange: (o: boolean) => void; batch?: Batch }) {
  const { branches, branchId } = useAuth();
  const navigate = useNavigate();
  const courses = useCourses();
  const blank = (): Values => ({
    batch_name: "",
    branch_id: String(branchId ?? (branches.length === 1 ? branches[0]!.branch_id : "")),
    course_id: "",
    curriculum_version_id: "",
    delivery_mode: "Classroom",
    trainer_user_id: "",
    schedule_days: "Mon, Tue, Wed, Thu, Fri",
    start_time: "",
    end_time: "",
    start_date: "",
    end_date: "",
    capacity: "20",
    min_students: "",
    location: "",
    status: "Planned",
    lms_course_id: "",
  });
  const form = useForm<Values>({ defaultValues: batch ? fromBatch(batch) : blank() });
  const { register, handleSubmit, watch, reset, formState, setValue } = form;
  useEffect(() => {
    if (open) reset(batch ? fromBatch(batch) : blank());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, batch?.batch_id]);

  const branch = watch("branch_id");
  const course = watch("course_id");
  const branchCode = useBranchCode(branch);
  const versions = useCurriculumVersions(course ? Number(course) : undefined, !!course);

  const save = useApiMutation(
    (body: BatchBody) => (batch ? batchesApi.update(batch.batch_id, body) : batchesApi.create(body)),
    {
      success: (b) => (batch ? `${b.batch_code} updated` : `Batch ${b.batch_code} created`),
      invalidate: [batchKeys.all, admissionKeys.all],
      silentValidation: true,
      onError: (e) => applyServerErrors(form, e),
      onSuccess: (b) => {
        onOpenChange(false);
        if (!batch) void navigate({ to: "/batches/$batchId", params: { batchId: String(b.batch_id) } });
      },
    },
  );

  const submit = handleSubmit((v) => {
    const full: BatchBody = {
      batch_name: v.batch_name.trim(),
      curriculum_version_id: v.curriculum_version_id ? Number(v.curriculum_version_id) : null,
      delivery_mode: v.delivery_mode,
      trainer_user_id: v.trainer_user_id ? Number(v.trainer_user_id) : null,
      schedule_days: v.schedule_days || null,
      start_date: v.start_date,
      end_date: v.end_date || null,
      capacity: Number(v.capacity),
      min_students: v.min_students ? Number(v.min_students) : null,
      location: v.location || null,
      status: v.status,
      lms_course_id: v.lms_course_id || null,
    };
    if (v.start_time) full.start_time = v.start_time;
    if (v.end_time) full.end_time = v.end_time;
    if (!batch) {
      // Omit an unset curriculum so the server picks the course's published version.
      if (!v.curriculum_version_id) delete full.curriculum_version_id;
      save.mutate({ ...full, branch_id: Number(v.branch_id), course_id: Number(v.course_id) });
      return;
    }
    // Edit: send only the fields that changed.
    const dirty = formState.dirtyFields as Partial<Record<keyof Values, boolean>>;
    const body = Object.fromEntries(Object.entries(full).filter(([k]) => dirty[k as keyof Values])) as BatchBody;
    if (!Object.keys(body).length) {
      onOpenChange(false);
      return;
    }
    save.mutate(body);
  });

  const err = (n: keyof Values) => formState.errors[n]?.message;
  const required = { required: "Required" };
  const courseOptions = (courses.data ?? [])
    .filter((c) => !c.is_combo && (!branchCode || c.branches.includes(branchCode)))
    .map((c) => ({ value: c.course_id, label: `${c.course_title} (${c.course_code})` }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] w-[calc(100vw-1.5rem)] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{batch ? `Edit ${batch.batch_code}` : "New batch"}</DialogTitle>
          <DialogDescription>Standalone courses only. The course's published curriculum version is used unless you choose one.</DialogDescription>
        </DialogHeader>
        <form id="batch-form" onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
          <Field label="Batch name" error={err("batch_name")} htmlFor="bt-name">
            <Input id="bt-name" {...register("batch_name", required)} />
          </Field>
          <Field label="Branch" error={err("branch_id")} htmlFor="bt-branch">
            <BranchSelect id="bt-branch" disabled={!!batch} {...register("branch_id", { ...required, onChange: () => setValue("trainer_user_id", "") })} value={branch} />
          </Field>
          <Field label="Course" error={err("course_id")} htmlFor="bt-course">
            <NativeSelect
              id="bt-course"
              disabled={!!batch}
              placeholder="Select course…"
              options={courseOptions}
              {...register("course_id", { ...required, onChange: () => setValue("curriculum_version_id", "") })}
              value={course}
            />
          </Field>
          <Field label="Curriculum version" error={err("curriculum_version_id")} htmlFor="bt-cv">
            <NativeSelect
              id="bt-cv"
              placeholder={batch ? "None" : "Course's published version"}
              options={(versions.data ?? []).filter((x) => x.status === "Published").map((x) => ({ value: x.curriculum_version_id, label: x.version_label }))}
              {...register("curriculum_version_id")}
              value={watch("curriculum_version_id")}
            />
          </Field>
          <Field label="Delivery mode" htmlFor="bt-mode">
            <NativeSelect id="bt-mode" options={DELIVERY_MODES.map((m) => ({ value: m, label: m }))} {...register("delivery_mode")} />
          </Field>
          <Field label="Trainer" error={err("trainer_user_id")} htmlFor="bt-trainer">
            <StaffSelect id="bt-trainer" branchId={branch ? Number(branch) : undefined} roles={["TRAINER"]} placeholder="Not assigned" {...register("trainer_user_id")} value={watch("trainer_user_id")} />
          </Field>
          <Field label="Start date" error={err("start_date")} htmlFor="bt-start">
            <Input id="bt-start" type="date" {...register("start_date", required)} />
          </Field>
          <Field label="Expected end date" error={err("end_date")} htmlFor="bt-end">
            <Input id="bt-end" type="date" {...register("end_date")} />
          </Field>
          <Field label="Start time" error={err("start_time")} htmlFor="bt-stime">
            <Input id="bt-stime" type="time" {...register("start_time")} />
          </Field>
          <Field label="End time" error={err("end_time")} htmlFor="bt-etime">
            <Input id="bt-etime" type="time" {...register("end_time")} />
          </Field>
          <Field label="Class days" error={err("schedule_days")} htmlFor="bt-days">
            <Input id="bt-days" {...register("schedule_days")} />
          </Field>
          <Field label="Room / link" error={err("location")} htmlFor="bt-loc">
            <Input id="bt-loc" {...register("location")} />
          </Field>
          <Field label="Capacity" error={err("capacity")} htmlFor="bt-cap">
            <Input id="bt-cap" type="number" min={1} {...register("capacity", required)} />
          </Field>
          <Field label="Minimum students" error={err("min_students")} htmlFor="bt-min">
            <Input id="bt-min" type="number" min={1} {...register("min_students")} />
          </Field>
          <Field label="Status" error={err("status")} htmlFor="bt-status">
            <NativeSelect id="bt-status" options={BATCH_STATUSES.map((s) => ({ value: s, label: s }))} {...register("status")} />
          </Field>
          <Field label="LMS course ID (optional)" error={err("lms_course_id")} htmlFor="bt-lms">
            <Input id="bt-lms" {...register("lms_course_id")} />
          </Field>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="batch-form" disabled={save.isPending}>
            {batch ? "Save changes" : "Create batch"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
