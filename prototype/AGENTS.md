<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

- Preserve the CRM as a frontend-only synthetic-data prototype; frozen business requirements are represented through shared UI screens and route wrappers because no backend or live service may be connected.
- Keep restricted configuration access as simulated UI-only role gating, because real server authorization cannot be demonstrated without the prohibited backend.
- Keep all cross-screen sample records in the shared in-memory store (src/lib/crm-store.tsx) with derived totals, because person/invoice/payment/admission/batch/report figures must reconcile and reset together.
