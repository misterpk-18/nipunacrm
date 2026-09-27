import { useState } from "react";
import { Plus } from "lucide-react";
import { batchKeys, batchesApi, useCurriculumVersions } from "@/api/batches";
import { useAuth } from "@/auth/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { CourseSelect, Field } from "@/components/crm/forms";
import { ConfirmAction, DataTable, Empty, Section, Status } from "@/components/crm/ui";
import { dateTime } from "@/lib/format";
import { useApiMutation } from "@/lib/mutation";
import { FormDialog } from "./shared";

/** Curriculum versions per course: create (optionally publish), publish a draft (retires the previous one). */
export function CurriculumVersions({ className }: { className?: string }) {
  const { hasRole } = useAuth();
  const [courseId, setCourseId] = useState("");
  const [form, setForm] = useState({ course_id: "", version_label: "", notes: "", publish: false });
  const versions = useCurriculumVersions(courseId ? Number(courseId) : undefined);
  const canManage = hasRole("FOUNDER_CEO", "SUPER_ADMIN", "ACADEMIC_COORDINATOR");
  const create = useApiMutation(
    () =>
      batchesApi.createCurriculumVersion({
        course_id: Number(form.course_id),
        version_label: form.version_label.trim(),
        notes: form.notes.trim() || null,
        publish: form.publish,
      }),
    { success: (v) => `Curriculum ${v.version_label} created`, invalidate: [batchKeys.curricula] },
  );
  const publish = useApiMutation(batchesApi.publishCurriculumVersion, {
    success: (v) => `${v.version_label} published — the previous version is retired`,
    invalidate: [batchKeys.curricula, batchKeys.all],
  });

  return (
    <Section
      title="Curriculum versions"
      subtitle="Admissions are mapped to a published version; batches follow one version"
      className={className}
      action={
        canManage ? (
          <FormDialog
            title="New curriculum version"
            disabled={!form.course_id || !form.version_label.trim()}
            onOpen={() => setForm({ course_id: courseId, version_label: "", notes: "", publish: false })}
            onSubmit={() => create.mutateAsync(undefined)}
            submitLabel="Create version"
            trigger={
              <Button size="sm" variant="outline">
                <Plus />
                New version
              </Button>
            }
          >
            <Field label="Course" htmlFor="cv-course">
              <CourseSelect id="cv-course" value={form.course_id} onChange={(e) => setForm({ ...form, course_id: e.target.value })} />
            </Field>
            <Field label="Version label" htmlFor="cv-label" hint="e.g. v2026.2">
              <Input id="cv-label" value={form.version_label} onChange={(e) => setForm({ ...form, version_label: e.target.value })} />
            </Field>
            <Field label="Notes (optional)" htmlFor="cv-notes">
              <Textarea id="cv-notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.publish} onChange={(e) => setForm({ ...form, publish: e.target.checked })} />
              Publish now (retires the currently published version)
            </label>
          </FormDialog>
        ) : undefined
      }
    >
      <div className="mb-3 max-w-md">
        <Field label="Filter by course" htmlFor="cv-filter">
          <CourseSelect id="cv-filter" value={courseId} placeholder="All courses" onChange={(e) => setCourseId(e.target.value)} />
        </Field>
      </div>
      <DataTable
        rows={versions.data}
        loading={versions.isLoading}
        error={versions.error}
        onRetry={() => void versions.refetch()}
        rowKey={(v) => v.curriculum_version_id}
        empty={<Empty title="No curriculum versions" />}
        columns={[
          { header: "Course", cell: (v) => <span className="block max-w-72 truncate">{`${v.course.course_title} (${v.course.course_code})`}</span> },
          { header: "Version", cell: (v) => <b>{v.version_label}</b> },
          { header: "Status", cell: (v) => <Status>{v.status}</Status> },
          { header: "Published", cell: (v) => dateTime(v.published_at) },
          { header: "Notes", cell: (v) => <span className="block max-w-56 truncate">{v.notes ?? "—"}</span> },
          {
            header: "",
            cell: (v) =>
              canManage && v.status === "Draft" ? (
                <ConfirmAction
                  title={`Publish ${v.version_label}?`}
                  description={`The currently published version of ${v.course.course_title} will be retired.`}
                  action="Publish"
                  onConfirm={() => publish.mutateAsync(v.curriculum_version_id)}
                  trigger={
                    <Button size="sm" variant="outline">
                      Publish
                    </Button>
                  }
                />
              ) : null,
          },
        ]}
      />
    </Section>
  );
}
