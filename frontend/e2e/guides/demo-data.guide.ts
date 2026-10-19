import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import { USERS } from "../helpers";
import { BRANCH, PROOF, claim, deal, demo, fee, invoiced, lead, paid } from "./demo";

/**
 * Base layer of realistic records so lists, queues and dashboards look like a working branch.
 * Run once before capturing guides (re-running adds another set). Each role guide also builds the
 * records its own workflows need.
 */
test("demo data for the role guides", async ({ page, request }) => {
  test.setTimeout(600_000);

  // Sample UPI receipt used as proof on non-cash claims
  if (!fs.existsSync(PROOF)) {
    fs.mkdirSync(path.dirname(PROOF), { recursive: true });
    await page.setViewportSize({ width: 360, height: 560 });
    await page.setContent(`<body style="margin:0;font-family:-apple-system,Helvetica,sans-serif;background:#f3f5f9">
      <div style="background:#0f9d58;color:#fff;padding:36px 20px 28px;text-align:center">
        <div style="width:56px;height:56px;border-radius:50%;background:#fff;color:#0f9d58;margin:0 auto 12px;font:700 32px/56px sans-serif">✓</div>
        <div style="font-size:15px;opacity:.9">Payment successful</div><div style="font-size:34px;font-weight:700;margin-top:6px">₹5,000</div></div>
      <div style="background:#fff;margin:16px;border-radius:12px;padding:16px;font-size:13px;line-height:2;color:#333">
        ${[["To", "<b>Nipuna Technologies</b>"], ["UPI ID", "nipunatech@icici"], ["From", "XXXXXX4821@ybl"], ["UPI Ref No.", "628914703355"], ["Date", "16 Oct 2026, 11:42 AM"]]
          .map(([k, v]) => `<div style="display:flex;justify-content:space-between"><span style="color:#777">${k}</span><span>${v}</span></div>`)
          .join("")}
      </div><div style="text-align:center;color:#999;font-size:11px">Sample proof for the CRM guide</div></body>`);
    await page.screenshot({ path: PROOF });
  }

  // New enquiries: a few unassigned (BM assigns them), a few owned by the counsellor
  for (const source of ["Website", "Google Ads", "Meta Ads", "Referral"] as const)
    await lead(request, { by: USERS.bmGnt, source, channel: source === "Referral" ? "Phone call" : "Web form", entry: source === "Google Ads" ? "Google Ads form" : "Staff entered" });
  for (const source of ["Walk-in", "Organic Social Media", "Website"] as const) await lead(request, { source, channel: source === "Walk-in" ? "In person" : "WhatsApp" });
  await lead(request, { by: USERS.foGnt, source: "Walk-in" });

  // Deals in counselling, with demos booked
  for (const h of [3, 27, 50]) await demo(request, await deal(request, { source: "Website", channel: "Web form", entry: "Website" }), h);
  await deal(request, { source: "Referral", channel: "Phone call", entry: "Staff entered" });

  // Fee discussions waiting on special closing: one within the BM limit, one only an admin can approve
  await fee(request, await deal(request), 800, "Two siblings joining; asked for a small concession to close today");
  await fee(request, await deal(request, { source: "Google Ads", channel: "Web form", entry: "Google Ads form" }), 4000, "Final-year student, family budget is tight; will pay in full today");

  // Invoiced deals with payment claims waiting for Accounts
  for (const amt of ["5000", "1000"]) {
    const l = await deal(request);
    await claim(request, l, (await invoiced(request, l)).invoice_id, amt, amt === "1000" ? "Cash" : "UPI / Bank Transfer");
  }

  // Admitted learners with balances due (collections, admissions, students)
  for (const [token, gap] of [[5000, 20], [1000, 40], [10000, 15]] as const) {
    const l = await deal(request);
    const inv = await invoiced(request, l, [token, gap]);
    await paid(request, l, inv.invoice_id, String(token));
  }

});

// Vijayawada: a little activity so company-wide views compare two branches
test("demo data at vijayawada", async ({ request }) => {
  test.setTimeout(300_000);
  const vij = USERS.salesVij;
  await lead(request, { by: vij, branch: BRANCH.VIJ, source: "Meta Ads", channel: "WhatsApp", entry: "Staff entered" });
  await demo(request, await deal(request, { by: vij, branch: BRANCH.VIJ }), 28);
  const v = await deal(request, { by: vij, branch: BRANCH.VIJ });
  await paid(request, v, (await invoiced(request, v)).invoice_id, "6000", USERS.accountsVij);
});
