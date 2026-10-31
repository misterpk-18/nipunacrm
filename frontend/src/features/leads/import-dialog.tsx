import { useRef, useState } from "react";
import { Check, Download, FileSpreadsheet, Upload } from "lucide-react";
import { leadKeys, leadsApi, type LeadImport, type LeadImportRow } from "@/api/leads";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DataTable, Status, Warning } from "@/components/crm/ui";
import { useApiMutation } from "@/lib/mutation";

const SAMPLE_CSV = `full_name,mobile,email,course,branch,source
Ravi Kumar,9876543210,ravi@example.com,NIT-CRS-001,NIT-GNT,Website
Sita Devi,9000012345,sita@example.com,,NIT-VIJ,Walk-in
`;

/** What the review screen calls each row's outcome (the API result plus whether it merged). */
function rowOutcome(r: LeadImportRow): { label: string; kind: "good" | "warn" | "danger" | "neutral" } {
  if (r.result === "Imported") return r.merged ? { label: "Merged", kind: "good" } : { label: "Created", kind: "good" };
  if (r.result === "Duplicate Review") return { label: "Will merge", kind: "warn" };
  if (r.result === "Invalid") return { label: "Invalid", kind: "danger" };
  return { label: "Will create", kind: "neutral" };
}

function downloadSample() {
  const url = URL.createObjectURL(new Blob([SAMPLE_CSV], { type: "text/csv" }));
  const link = Object.assign(document.createElement("a"), { href: url, download: "leads-sample.csv" });
  link.click();
  URL.revokeObjectURL(url);
}

/** CSV lead import: upload (stored in S3) → check mandatory fields and data types, see sample records → import / merge the valid rows. */
export function ImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [batch, setBatch] = useState<LeadImport | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  const uploadFile = useApiMutation(leadsApi.uploadImport, { onSuccess: setBatch });
  const run = useApiMutation((id: number) => leadsApi.runImport(id), {
    success: (b) => `Imported ${b.import_code}: ${b.imported_rows - b.merged_rows} new, ${b.merged_rows} merged`,
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

  const importable = batch ? batch.ready_rows + batch.duplicate_rows : 0;
  const problems = batch?.rows?.filter((r) => r.issues.length > 0) ?? [];

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[90vh] w-[calc(100vw-1.5rem)] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import leads from CSV</DialogTitle>
          <DialogDescription>
            Required columns: full_name, mobile, email, branch (NIT-GNT / NIT-VIJ), source. Optional: course (code or title). Rows are checked before anything is imported.
          </DialogDescription>
        </DialogHeader>
        {!batch ? (
          <div className="space-y-3">
            <input ref={picker} type="file" accept=".csv,text/csv" aria-label="CSV file" className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" variant="outline" onClick={() => picker.current?.click()}>
                <FileSpreadsheet />
                {file ? "Change file" : "Choose CSV file"}
              </Button>
              <span className="text-sm text-muted-foreground">{file ? file.name : "No file chosen"}</span>
            </div>
            <Button type="button" variant="link" className="h-auto p-0" onClick={downloadSample}>
              <Download />
              Download a sample CSV
            </Button>
            <Warning>
              People who already exist (same mobile or email) are merged: empty fields are filled, nothing is overwritten, and the new lead is added to them. The file is kept
              for audit. Imports don't create admissions or satisfy lead SLAs.
            </Warning>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Status kind="neutral">{batch.import_code}</Status>
              <Status>{batch.status}</Status>
              <span>
                {batch.ready_rows} new · {batch.duplicate_rows} to merge · {batch.invalid_rows} invalid of {batch.total_rows} rows
              </span>
              {batch.storage_path && <span className="text-muted-foreground">File saved: {batch.storage_path}</span>}
            </div>

            {batch.preview && (
              <>
                <section aria-label="Column checks" className="space-y-2">
                  <h3 className="text-sm font-semibold">Column checks</h3>
                  <DataTable
                    stack
                    rows={batch.preview.columns}
                    rowKey={(c) => c.column}
                    columns={[
                      { header: "Column", cell: (c) => c.column },
                      { header: "Expected", cell: (c) => c.type },
                      { header: "Mandatory", cell: (c) => (c.required ? "Yes" : "No") },
                      { header: "Filled", cell: (c) => `${c.filled} / ${batch.total_rows}` },
                      { header: "Problems", cell: (c) => (c.invalid ? <Status kind="danger">{c.invalid}</Status> : <Status kind="good">None</Status>) },
                    ]}
                  />
                  {batch.preview.ignored_columns.length > 0 && (
                    <p className="text-sm text-muted-foreground">Ignored columns: {batch.preview.ignored_columns.join(", ")}</p>
                  )}
                </section>

                <section aria-label="Sample records" className="space-y-2">
                  <h3 className="text-sm font-semibold">Sample records (first {batch.preview.sample_rows.length})</h3>
                  <RowsTable rows={batch.preview.sample_rows} />
                </section>
              </>
            )}

            {problems.length > 0 && (
              <section aria-label="Rows with problems" className="space-y-2">
                <h3 className="text-sm font-semibold">Rows with problems ({problems.length})</h3>
                <RowsTable rows={problems} />
              </section>
            )}

            {batch.imported_at && (
              <p role="status" className="rounded-md border border-success/40 bg-success/10 p-3 text-sm">
                <Check className="mr-1 inline size-4" />
                Import complete: {batch.imported_rows - batch.merged_rows} new people, {batch.merged_rows} merged into existing people.
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
              {uploadFile.isPending ? "Uploading…" : "Upload and check"}
            </Button>
          ) : (
            !batch.imported_at && (
              <Button disabled={run.isPending || importable === 0} onClick={() => run.mutate(batch.import_id)}>
                Import {importable} rows ({batch.duplicate_rows} merge)
              </Button>
            )
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RowsTable({ rows }: { rows: LeadImportRow[] }) {
  return (
    <DataTable
      rows={rows}
      rowKey={(r) => r.row_no}
      columns={[
        { header: "Row", cell: (r) => r.row_no },
        { header: "Name", cell: (r) => r.full_name ?? r.raw_data["full_name"] ?? "—" },
        { header: "Mobile", cell: (r) => r.phone ?? r.raw_data["mobile"] ?? "—" },
        { header: "Email", cell: (r) => r.email ?? r.raw_data["email"] ?? "—" },
        { header: "Course", cell: (r) => r.raw_data["course"] ?? "—" },
        { header: "Branch", cell: (r) => r.raw_data["branch"] ?? "—" },
        { header: "Checks", cell: (r) => (r.issues.length ? r.issues.join("; ") : "OK"), className: "whitespace-normal" },
        { header: "Result", cell: (r) => <Status kind={rowOutcome(r).kind}>{rowOutcome(r).label}</Status> },
      ]}
    />
  );
}
