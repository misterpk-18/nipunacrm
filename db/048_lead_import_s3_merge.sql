-- CSV lead import: keep the uploaded file in object storage (S3) and merge rows into existing people.
--   lead_imports.storage_path          where the original CSV is kept (s3://bucket/key, or a local path when no bucket is set)
--   lead_import_rows.matched_person_id the existing person a row matches (same mobile or email); the import merges into them
--   lead_import_rows.merged            true once the row was merged into that person instead of creating a new one
-- Depends on: 047_website_enquiries.sql

ALTER TABLE lead_imports
    ADD COLUMN storage_path TEXT;

ALTER TABLE lead_import_rows
    ADD COLUMN matched_person_id INT REFERENCES persons(person_id),
    ADD COLUMN merged BOOLEAN NOT NULL DEFAULT FALSE,
    ADD CONSTRAINT lead_import_rows_merged_needs_import CHECK (NOT merged OR result = 'Imported');

COMMENT ON COLUMN lead_import_rows.matched_person_id IS 'Existing person with the same mobile or email; the import merges into this person (fills empty fields, adds a lead), never overwrites';
