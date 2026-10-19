import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { PASSWORD, USERS, acceptDeliveryPlan, apiToken, createInvoice, login, qualifyAndConvert, recordPayment, verifyPayment } from "../helpers";

/**
 * Realistic sample records for the role guides, built through the API (the same calls the screens make).
 * Every builder makes a fresh person with a unique mobile, so guides can be re-run.
 */

type Headers = Record<string, string>;
type Lookup = { id: number; label: string };

export const BRANCH = { GNT: 1, VIJ: 2 } as const;
/** Demo trainer per branch: Trainer G1 (Guntur) · Trainer V1 (Vijayawada). */
export const TRAINER: Record<number, number> = { 1: 8, 2: 17 };

const FIRST = ["Aarav", "Sravya", "Nikhil", "Pooja", "Harsha", "Deepika", "Tarun", "Likhitha", "Vinay", "Sowmya", "Kalyan", "Bindu", "Rakesh", "Mounika", "Ajay", "Niharika", "Siddharth", "Ramya", "Gowtham", "Hasini", "Chaitanya", "Prathyusha", "Manikanta", "Revathi", "Abhinav", "Tejaswi", "Dinesh", "Kavya", "Sandeep", "Varsha"];
const LAST = ["Reddy", "Naidu", "Chowdary", "Varma", "Rao", "Sharma", "Goud", "Kumar", "Prasad", "Murthy", "Sastry", "Yadav", "Raju", "Patnaik"];

let seq = 0;
const salt = Date.now() % 997;
/** A realistic name; varies per call and per run. */
export function personName() {
  seq++;
  return `${FIRST[(salt + seq * 7) % FIRST.length]} ${LAST[(salt * 3 + seq * 5) % LAST.length]}`;
}

/** A unique 10-digit Indian mobile starting 6–9. */
export function mobile() {
  const tail = String(Date.now() * 10 + (seq++ % 10)).slice(-9);
  return `${"6789"[seq % 4]}${tail}`;
}

const cache = new Map<string, Headers>();
export async function as(request: APIRequestContext, email: string) {
  if (!cache.has(email)) cache.set(email, await apiToken(request, email));
  return cache.get(email)!;
}

async function data<T>(res: import("@playwright/test").APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()).data as T;
}

let lookups: Record<string, Lookup[]> | null = null;
async function lookup(request: APIRequestContext, headers: Headers, key: string, label: string) {
  const all = (lookups ??= await data<Record<string, Lookup[]>>(await request.get("/api/v1/lookups", { headers })));
  return all[key]!.find((l) => l.label === label)!.id;
}

/** Course ids that run at both branches (dev): 4 NIT-CRS-007 ₹22,000 · 1 NIT-CRS-018 ₹30,000 · 7 NIT-CRS-025 ₹18,000 · 6 NIT-CRS-028 ₹25,000 · 3 NIT-CRS-052 ₹24,000 … */
export const COURSES = [4, 1, 5, 7, 8, 6, 2, 3];

export type LeadOpts = {
  /** Who creates it; that counsellor owns it. Defaults to sales.gnt. */
  by?: string;
  branch?: number;
  name?: string;
  course?: number | null;
  source?: "Organic Social Media" | "Google Ads" | "Walk-in" | "Referral" | "Website" | "College Data" | "Meta Ads";
  channel?: "WhatsApp" | "Phone call" | "Outbound call" | "In person" | "Web form" | "Email";
  entry?: "Staff entered" | "Google Ads form" | "Walk-in desk" | "Website";
};

export type DemoLead = { lead_id: number; lead_code: string; name: string; phone: string; branch: number; headers: Headers };

export async function lead(request: APIRequestContext, o: LeadOpts = {}): Promise<DemoLead> {
  const headers = await as(request, o.by ?? USERS.salesGnt);
  const name = o.name ?? personName();
  const phone = mobile();
  const first = name.split(" ")[0]!.toLowerCase();
  const res = await data<{ lead_id: number; lead_code: string }>(
    await request.post("/api/v1/leads", {
      headers,
      data: {
        branch_id: o.branch ?? BRANCH.GNT,
        person: { full_name: name, phone, email: `${first}.${phone.slice(-4)}@gmail.com` },
        course_id: o.course === undefined ? COURSES[seq % COURSES.length] : o.course,
        lead_source_id: await lookup(request, headers, "lead_sources", o.source ?? "Walk-in"),
        contact_channel_id: await lookup(request, headers, "contact_channels", o.channel ?? "In person"),
        entry_method_id: await lookup(request, headers, "entry_methods", o.entry ?? "Walk-in desk"),
      },
    }),
  );
  return { ...res, name, phone, branch: o.branch ?? BRANCH.GNT, headers };
}

/** A lead qualified and converted to a deal (pipeline card at Counselling). */
export async function deal(request: APIRequestContext, o: LeadOpts = {}) {
  const l = await lead(request, o);
  await qualifyAndConvert(request, l.headers, l.lead_id);
  return l;
}

/** Demo booked `inHours` from now with the branch's trainer. */
export async function demo(request: APIRequestContext, l: DemoLead, inHours = 26) {
  const at = new Date(Date.now() + inHours * 3600_000);
  at.setMinutes(0, 0, 0);
  return data<{ demo_id: number; demo_code: string }>(
    await request.post(`/api/v1/leads/${l.lead_id}/demos`, {
      headers: l.headers,
      data: { scheduled_at: at.toISOString(), trainer_user_id: TRAINER[l.branch], duration_minutes: 45 },
    }),
  );
}

/** Fee discussion with one version; `concession` > 0 makes it need a special closing request (raised here). */
export async function fee(request: APIRequestContext, l: DemoLead, concession = 0, reason = "Comparing with another institute; ready to join this week") {
  const d = await data<{ fee_discussion_id: number }>(await request.post(`/api/v1/leads/${l.lead_id}/fee-discussions`, { headers: l.headers, data: {} }));
  const v = await data<{ version_id: number; final_payable: string }>(
    await request.post(`/api/v1/fee-discussions/${d.fee_discussion_id}/versions`, { headers: l.headers, data: concession ? { extra_concession: String(concession) } : {} }),
  );
  if (!concession) {
    await data(await request.post(`/api/v1/fee-discussion-versions/${v.version_id}/approve`, { headers: l.headers }));
    return { discussion: d, version: v, scr: null };
  }
  const scr = await data<{ scr_id: number; scr_code: string }>(
    await request.post(`/api/v1/fee-discussion-versions/${v.version_id}/special-closing-requests`, { headers: l.headers, data: { request_reason: reason } }),
  );
  return { discussion: d, version: v, scr };
}

/** Approved fee + accepted delivery plan + invoice: one instalment, or `[token, days]` = token today and the rest in `days`. */
export async function invoiced(request: APIRequestContext, l: DemoLead, split?: [token: number, days: number]) {
  const { version } = await fee(request, l);
  await acceptDeliveryPlan(request, l.headers, l.lead_id);
  const total = Number(version.final_payable);
  const schedule = split && [
    { due_date: day(0), amount: split[0].toFixed(2) },
    { due_date: day(split[1]), amount: (total - split[0]).toFixed(2) },
  ];
  return createInvoice(request, l.headers, [l.lead_id], schedule);
}

/** Sample UPI receipt attached as proof to non-cash claims (rendered by demo-data.guide.ts). */
export const PROOF = path.join(path.dirname(fileURLToPath(import.meta.url)), "assets", "upi-proof.png");

/** A payment claim recorded by the counsellor and left pending for Accounts (non-cash claims carry the proof image). */
export async function claim(request: APIRequestContext, l: DemoLead, invoiceId: number, amount: string, mode: "Cash" | "UPI / Bank Transfer" = "UPI / Bank Transfer") {
  if (mode === "Cash") return recordPayment(request, l.headers, invoiceId, amount, mode);
  const res = await data<{ payment: { payment_id: number; transaction_number: string } }>(
    await request.post("/api/v1/payments", {
      headers: l.headers,
      multipart: {
        invoice_id: String(invoiceId),
        amount,
        payment_mode_id: String(await lookup(request, l.headers, "payment_modes", mode)),
        reference: `UPI${String(Date.now()).slice(-10)}`,
        proof: { name: "upi-receipt.png", mimeType: "image/png", buffer: fs.readFileSync(PROOF) },
      },
    }),
  );
  return res.payment;
}

/** Claim + Accounts verification (issues the receipt; ₹1,000+ admits the course). */
export async function paid(request: APIRequestContext, l: DemoLead, invoiceId: number, amount: string, accounts: string = USERS.accountsGnt) {
  const p = await claim(request, l, invoiceId, amount);
  return verifyPayment(request, await as(request, accounts), p.payment_id);
}

export const day = (n: number) => new Date(Date.now() + 5.5 * 3600_000 + n * 86_400_000).toISOString().slice(0, 10);

/** Sign in through the login screen (fresh session). */
export async function signIn(page: Page, email: string) {
  await page.evaluate(() => window.sessionStorage.clear()).catch(() => undefined);
  await login(page, email);
}

/** Answer the fresh-password prompt if the action asks for one. */
export async function freshAuth(page: Page) {
  // only the confirm-your-password dialog (it has Continue), never a form that happens to have a Password field
  const prompt = page.getByRole("dialog").filter({ has: page.getByRole("button", { name: "Continue" }) });
  if (await prompt.isVisible({ timeout: 3000 }).catch(() => false)) {
    await prompt.getByLabel("Password").fill(PASSWORD);
    await prompt.getByRole("button", { name: "Continue" }).click();
  }
}
