# Nipuna CRM Audit Corrections

## Goal
Correct the existing prototype in place so branch scope, demo roles, tabs, mobile counsellor workflows, student actions, and safety feedback behave as specified without changing the visual system or route structure.

## Scope and Roles
- Add one shared in-browser role and branch provider that survives route changes.
- Let Super Admin / Director choose All Branches, Guntur, or Vijayawada.
- Lock branch managers and counsellors to their assigned branch and hide other-branch operational records.
- Add a clearly labeled Prototype Role selector that routes managers and counsellors to their relevant starting screen.

## Screen Corrections
- Apply branch-aware sample records and computed sample metrics to Dashboard, Leads, Counsellor Workspace, Pipeline, Demos, Admissions, Students, Payments, Collections, and Reports.
- Make Counsellor Workspace, Lead 360, Collections, and Tasks tabs display distinct filtered content or an explicit empty state.
- Preserve Student 360 tab behavior while adding Create Support Case and the complete Ananya admission timeline.
- Replace counsellor mobile navigation with Today Queue, Leads, Demos, Tasks, and Collections; use mobile lead cards with prominent demo Call and WhatsApp actions.

## Prototype Safety
- Mask sample phone numbers and retain `example.test` emails.
- Mark metric and financial values as SAMPLE DATA.
- Correct FlowLink routing and show clear demo feedback for Call, WhatsApp, Share Fee, Retry, Open LMS, export, and similar inert actions.
- Keep all state local with no database, backend, credentials, or live integrations.

## Verification
- Check role changes, branch locking, branch filtering, tab results, and the lead-to-student journey.
- Verify navigation and layouts at desktop and mobile widths, including no horizontal scrolling in primary counsellor workflows.
