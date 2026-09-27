import { useState } from "react";
import { Check, Upload } from "lucide-react";
import { leadKeys, leadsApi, type LeadImport } from "@/api/leads";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DataTable, Status, Warning } from "@/components/crm/ui";
import { useApiMutation } from "@/lib/mutation";

/** CSV lead import: upload → review validation / duplicate results per row → import the ready rows. */
export function ImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [batch, setBatch] = useState<LeadImport | null>(null);

  const uploadFile = useApiMutation(leadsApi.uploadImport, { onSuccess: setBatch });
  const run = useApiMutation((id: number) => leadsApi.runImport(id), {
    success: (b) => `Imported ${b.import_code}`,
    invalidate: [leadKeys.all],
    onSuccess: setBatch,
  });

  const close = (next: boolean) => {
    if (!next) {
      setFile(null);
      setBatch(null);
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[90vh] w-[calc(100vw-1.5rem)] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import leads from CSV</DialogTitle>
          <DialogDescription>
            Columns: full_name, mobile, email, course (code or title), branch (NIT-GNT / NIT-VIJ), source. Rows are checked before anything is imported.
          </DialogDescription>
        </DialogHeader>
        {!batch ? (
          <div className="space-y-3">
            <input type="file" accept=".csv,text/csv" aria-label="CSV file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="block text-sm" />
            <Warning>Duplicates never merge automatically. Imports don't create admissions or satisfy lead SLAs.</Warning>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2 text-sm">
              <Status kind="neutral">{batch.import_code}</Status>
              <Status>{batch.status}</Status>
              <span>
                {batch.ready_rows} ready · {batch.duplicate_rows} duplicate review · {batch.invalid_rows} invalid of {batch.total_rows}
              </span>
            </div>
            <DataTable
              rows={batch.rows}
              rowKey={(r) => r.row_no}
              columns={[
                { header: "Row", cell: (r) => r.row_no },
                { header: "Name", cell: (r) => r.full_name ?? r.raw_data["full_name"] ?? "—" },
                { header: "Mobile", cell: (r) => r.phone ?? r.raw_data["mobile"] ?? "—" },
                { header: "Course", cell: (r) => r.raw_data["course"] ?? "—" },
                { header: "Branch", cell: (r) => r.raw_data["branch"] ?? "—" },
                { header: "Checks", cell: (r) => (r.issues.length ? r.issues.join("; ") : "OK"), className: "whitespace-normal" },
                { header: "Result", cell: (r) => <Status>{r.result}</Status> },
              ]}
            />
            {batch.imported_at && (
              <p role="status" className="rounded-md border border-success/40 bg-success/10 p-3 text-sm">
                <Check className="mr-1 inline size-4" />
                Import complete. Duplicate rows are held in Duplicate Review.
              </p>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)}>
            Close
          </Button>
          {!batch ? (
            <Button disabled={!file || uploadFile.isPending} onClick={() => file && uploadFile.mutate(file)}>
              <Upload />
              Check file
            </Button>
          ) : (
            !batch.imported_at && (
              <Button disabled={run.isPending || batch.ready_rows + batch.duplicate_rows === 0} onClick={() => run.mutate(batch.import_id)}>
                Import {batch.ready_rows + batch.duplicate_rows} rows
              </Button>
            )
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
