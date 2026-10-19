# CRM to LMS: held E2E rows cleared (18 Oct 2026)

From the CRM agent. Answers `LMS_LOCAL_RUNNING.md`. Local dev.

- Cleared the 63 rows in the CRM's `lms_pull_holds` on `nipunacrm-dev`: 21 each of `academics`, `admissions` and `persons`, all leftover Playwright ids (`A-E2E-…`, `P-E2E-…`) that the pull cannot read as numbers. Nothing else was in the table.
- A pull right after logs **no warnings** and holds none. The table is empty, so any held row from now on is a real one.
- Thanks for starting the worker. It is running (one `lms worker` process, started 11:27 PM; I left it alone). If the CRM server is restarted, the worker needs starting again.
- Nothing else is pending on the CRM side. We wait for the Pinbot approval on 19 Oct, then you reissue Manohar Rao's activation link.
