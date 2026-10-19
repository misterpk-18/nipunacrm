# Nipuna CRM — Website integration guide

**For:** the developer / agent building the enquiry flows on **nipunatechnologies.com**
**From:** the Nipuna CRM team
**Version:** 1.2 · 19 Oct 2026
**Status:** **Live in production.** Endpoint: `https://nipunacrm.com/api/v1/integrations/website/enquiries`. The service key has been shared with you separately.

---

## 0. Reply to your request

Thank you for the detailed requirements. Here is where each one stands.

| # | Your requirement | Answer |
|---|---|---|
| 1 | Website contact / enquiry form | **Ready now.** Send with `enquiry_type: "form"` |
| 2 | Name + phone from the Call / WhatsApp popup | **Ready now.** Send with `enquiry_type: "call_request"` or `"whatsapp_request"`. The popup must also send the branch (section 4.3) |
| 3 | Facebook / Instagram Instant Form leads | **Next phase** (section 11). Until then you may forward them to this same endpoint |
| 4 | Google Ads lead-form submissions | **Next phase** (section 11). Until then you may forward them to this same endpoint |
| 5 | Meta / Google ad visitors who use the website form or popup | **Ready now.** Send `marketing_source` and the UTM values (section 5) |
| — | "Automatic lead creation" | Every submission is created **automatically** in the CRM's **Enquiries** queue the moment you send it. CRM staff then convert it into a lead after a quick duplicate check. This review step is the business's rule, so no person or lead is ever merged or duplicated by mistake. Nothing extra is needed from you |
| — | Keep name, mobile, optional email, course, branch | ✅ `name`, `phone`, `email`, `course_code`, `branch_code` |
| — | Original submission time | ✅ `submitted_at` (section 3) |
| — | Unique source lead ID | ✅ `submission_id`. The same ID is never stored twice |
| — | Campaign / ad / form details and tracking parameters | ✅ Five UTM values (`source`, `medium`, `campaign`, `term`, `content`), `page_url` and `referrer`. ⚠️ `gclid`, `fbclid` and campaign / ad / form **IDs** are not stored for now. Put campaign / ad names in `utm.campaign` / `utm.content` |
| — | Marketing source separate from enquiry type | ✅ `marketing_source` (Google Ads / Meta Ads / organic) and `enquiry_type` (form / call request / WhatsApp request) are separate fields and are shown separately to staff |
| — | Route to NIT-GNT or NIT-VIJ | ✅ `branch_code` (required) |
| — | Prevent duplicate imports | ✅ By `submission_id` (exact repeats) and by the CRM's duplicate review (same mobile / email) |
| — | Retry handling for failed deliveries | ✅ Safe to retry: repeats of the same `submission_id` return the original record. Retrying and queuing are done on your side (section 7) |
| — | Google Sheets backup continues independently | ✅ Keep it. Section 7.3 describes the recommended order |
| — | API / webhook details | This document |
| — | Permissions | One service key, which can only create website enquiries. It cannot read or change anything in the CRM (section 2) |
| — | Timeline and charges | The CRM endpoint is live today. Meta and Google do not charge for lead webhooks. Commercial terms and dates for the advertising phase come from the Nipuna CRM owner |

**Please start with flows 1 and 2.** Section 10 is the go-live checklist.

---

## 1. How it works

```
Visitor's browser ──(form / popup)──▶ Website SERVER (your backend or serverless function)
                                        1. CAPTCHA + honeypot check
                                        2. validate fields
                                        3. write the Google Sheets backup row
                                        4. POST to the CRM with the service key   ──HTTPS──▶ Nipuna CRM
                                        5. record the result (enquiry code or error)          │
                                                                                               ▼
                                                                         Enquiries queue (Guntur / Vijayawada)
                                                                         Branch Manager + Founder notified
                                                                         staff convert → Lead → follow-ups
```

What happens in the CRM after you send:

1. The submission is saved as an **enquiry** with a code such as `ENQ-00342` (returned to you).
2. It appears in **Enquiries** for the chosen branch. The Branch Manager, the Founder and the Super Admin get a notification.
3. If the mobile or email matches an existing person, or another enquiry from the last 24 hours, it is marked **Duplicate Review**. The CRM never merges anything automatically.
4. Staff **convert** it into a lead, **link** it to an existing lead, or mark it **Invalid-Spam** / **Test**.
5. The lead then follows the normal CRM process: assignment, qualification and follow-ups. The 10-minute first-contact clock counts from `submitted_at`.

---

## 2. Authentication and security

| | |
|---|---|
| Method | `POST` |
| URL | `https://nipunacrm.com/api/v1/integrations/website/enquiries` |
| Headers | `Content-Type: application/json` · `X-Service-Key: <the key shared with you>` |
| Body size | Under 16 KB (larger bodies are rejected with 413) |
| Timeout | 10 seconds per attempt |

**Rules (non-negotiable):**

1. **Server-to-server only.** Keep the key in a server environment variable or secret store, e.g. `CRM_WEBSITE_KEY`. It must **never** appear in browser JavaScript, HTML, the page source, a public repository, logs, error messages or analytics. Browser (CORS) calls are not allowed.
2. If the site has no backend (a static site or site builder), add a small serverless function (Vercel, Netlify, Cloudflare Workers, AWS Lambda) that makes the CRM call.
3. HTTPS only. Don't disable certificate checks.
4. **Permissions:** the key can only create website enquiries. It cannot read, list, change or delete CRM data, and a CRM staff login does not work on this endpoint.
5. **If the key leaks** (or someone leaves the project), tell the CRM team at once. The CRM team issues a new key, and the old one stops working as soon as the new one is installed.

---

## 3. Request fields

```json
{
  "submission_id": "web-6f1c2a8e-4b1d-4f7e-9a51-0d3c2e9b7a10",
  "name": "Ravi Kumar",
  "phone": "9876543210",
  "email": "ravi@example.com",
  "branch_code": "NIT-VIJ",
  "enquiry_type": "form",
  "marketing_source": "google_ads",
  "submitted_at": "2026-10-19T17:42:05+05:30",
  "course_code": "NIT-CRS-052",
  "message": "Is there a weekend batch?",
  "whatsapp_consent": true,
  "utm": { "source": "google", "medium": "cpc", "campaign": "oct-python", "term": "python course", "content": "ad-1" },
  "page_url": "https://nipunatechnologies.com/courses/python-full-stack",
  "referrer": "https://www.google.com/"
}
```

| Field | Required | Allowed values / limits | Notes |
|---|---|---|---|
| `submission_id` | **Yes** | 1–100 chars: letters, digits, `.` `_` `:` `-` | **Your unique source lead ID.** Create it **once** when the visitor submits (e.g. `web-` + UUID, `popup-` + UUID) and use the **same** value on every retry and re-send. Store it next to your Google Sheets row |
| `name` | **Yes** | 2–150 chars | Full name, trimmed |
| `phone` | **Yes** | See below | The mobile number as typed |
| `email` | No | Valid email, ≤ 255 | `null` or leave out if not collected |
| `branch_code` | **Yes** | `NIT-GNT` or `NIT-VIJ` (any case) | Section 4.1 |
| `enquiry_type` | **Yes** | `form` · `call_request` · `whatsapp_request` | Which flow it came from (section 4.3) |
| `marketing_source` | No | `google_ads` · `meta_ads` · `organic` (default `organic`) | Where the visitor came from (section 5). Any other value → 400 |
| `submitted_at` | Recommended | ISO 8601 **with a timezone offset** | The moment the visitor pressed submit. Set it once and reuse it on retries. The CRM uses it as the enquiry time if it is less than 48 hours old; otherwise it uses its own time and keeps yours for reference. A time without an offset → 400 |
| `course_code` | No | ≤ 100 chars | A code from section 4.2. Leave out for "Not sure yet". An unknown code, or a course the branch doesn't offer, is still accepted: staff see "Course asked on website: …" |
| `message` | No | ≤ 2,000 chars | The visitor's text |
| `whatsapp_consent` | No | `true` / `false` | Section 6. Leave out if the form has no checkbox |
| `utm` | No | Object; `source`, `medium`, `campaign`, `term`, `content`, each ≤ 200 | Section 5. Empty values are dropped |
| `page_url` | No | ≤ 500 | The page where the form / popup was submitted |
| `referrer` | No | ≤ 500 | `document.referrer` captured on the landing page |

**Phone numbers.** Spaces, `-`, `(`, `)` and `.` are ignored.

| Sent | Stored as |
|---|---|
| `9876543210`, `098765 43210`, `98765-43210` | `+919876543210` |
| `919876543210`, `+91 98765 43210` | `+919876543210` |
| `+447700900123` (non-Indian, 10–15 digits after `+`) | `+447700900123` |
| `12345`, letters, a 9-digit number | rejected (400) |

Any other fields are ignored. Trim all text before sending.

---

## 4. Reference values

### 4.1 Branches (`branch_code`, required)

| Code | Branch |
|---|---|
| `NIT-GNT` | Guntur |
| `NIT-VIJ` | Vijayawada |

### 4.2 Courses (`course_code`, optional)

Offered at both branches today:

| Code | Course |
|---|---|
| `NIT-CRS-007` | AWS with DevOps |
| `NIT-CRS-018` | Data Science with Python, SQL, Machine Learning & Applied AI |
| `NIT-CRS-019` | Microsoft Power BI Data Analytics & Business Intelligence |
| `NIT-CRS-025` | Professional Graphic Design with AI Tools |
| `NIT-CRS-026` | Professional Video Editing with AI Tools |
| `NIT-CRS-028` | Complete Digital Marketing |
| `NIT-CRS-047` | Java Full Stack Developer |
| `NIT-CRS-052` | Python Full Stack Developer |

Use the code as the dropdown `value` and the title as the label, plus a "Not sure yet" option that sends no `course_code`. Course pages can send their own course automatically. The CRM team will tell you about course changes; until you update the list, an unknown code is kept as text, so nothing is lost.

### 4.3 Enquiry type (`enquiry_type`, required)

| Flow on the website | `enquiry_type` | Shown to CRM staff as |
|---|---|---|
| Contact / enquiry form | `form` | Web form |
| Popup → "Call me" / Call button | `call_request` | Phone call (a call request) |
| Popup → WhatsApp button | `whatsapp_request` | WhatsApp (a WhatsApp request) |

**The popup must send `branch_code` too.** Either add a two-button branch choice (Guntur / Vijayawada) to the popup, or set it from the page when a page belongs to one branch. A popup submission without a branch is rejected.

Minimum popup body:

```json
{ "submission_id": "popup-0b6e3c1a-91f2-4d7a-8c55-2f1e7a9d4c33", "name": "Sita", "phone": "9000000000",
  "branch_code": "NIT-GNT", "enquiry_type": "whatsapp_request", "submitted_at": "2026-10-19T18:02:11+05:30" }
```

---

## 5. Marketing source and tracking

`marketing_source` is **decided by the website**. The CRM stores it as sent and never infers it from UTM values. Recommended rules, applied on the **landing** page and remembered for the visit (e.g. in `sessionStorage` or a first-party cookie for 30 days):

| Landing URL has | `marketing_source` |
|---|---|
| `gclid`, `gbraid` or `wbraid`, or `utm_source=google` with `utm_medium` = `cpc` / `ppc` / `paid` | `google_ads` |
| `fbclid`, or `utm_source` = `facebook` / `instagram` / `meta` / `fb` / `ig` with a paid `utm_medium` (`cpc`, `paid`, `paid_social`) | `meta_ads` |
| Anything else (search, direct, social posts, referral) | `organic` |

Also capture the five `utm_*` parameters, the landing `referrer` and the `page_url` of the submission, and send them with the form. If a visitor lands from an ad and submits later in the same visit, still send the ad source.

The CRM does **not** store `gclid` / `fbclid` or campaign / ad / form IDs yet. Keep them in your Google Sheet if you need them for ad reporting.

---

## 6. WhatsApp consent

On the enquiry form (optional on the popup), add an **unticked** checkbox:

> ☐ I agree to receive course updates and offers from Nipuna Technologies on WhatsApp.

Send `true` only when ticked and `false` when not, and never pre-tick it. When staff convert the enquiry, the CRM records the consent against the person ("Web form", with the submission time). It never overrides a choice the person has already made. A visitor who clicks the popup's WhatsApp button has not given marketing consent by doing so; send `whatsapp_consent` only from the checkbox.

---

## 7. Responses, retries and backup

### 7.1 Responses

| Status | Meaning | Body | Website action |
|---|---|---|---|
| **201** | Saved | `{"data": {"enquiry_code": "ENQ-00342", "status": "received"}}` | Success. Show the thank-you message and store `enquiry_code` with your row |
| **200** | Already received (same `submission_id`) | `{"data": {"enquiry_code": "ENQ-00342", "status": "duplicate_submission"}}` | Success, nothing new created |
| **400** | Invalid data | `{"error": {"code": "VALIDATION_ERROR", "message": "Invalid request data", "details": {"phone": ["Not a valid phone number"]}}}` | Show the messages to the visitor. Do not retry unchanged |
| **401** | Wrong / missing key | `{"error": {"code": "UNAUTHENTICATED", "message": "Invalid service key"}}` | Configuration error: alert your team, keep the submission queued |
| **409** | Same `submission_id` being saved at this moment | `{"error": {"code": "CONFLICT", ...}}` | Retry after 1 s with the same body (you will get 200) |
| **413** | Body over 16 KB | HTML error page | Shorten the message |
| **429** | Too many: one mobile more than 5 times an hour, more than 30 a minute in total, or too many requests from your server's IP | JSON (`TOO_MANY_ATTEMPTS`) or a plain error page | Ask the visitor to try later. Don't retry immediately. Queued re-sends: wait a minute |
| **5xx**, timeout, network error | Temporary problem | — | Retry (7.2) |

Error bodies always have `error.code`, `error.message` and, for 400, `error.details` (field → list of messages). The response never reveals whether the visitor is already known to the CRM.

### 7.2 Retries

- One `submission_id` and one `submitted_at` per submission, reused on every attempt.
- Retry on 409, 5xx, timeouts and network errors: up to 3 more attempts, after 1 s, 3 s and 10 s.
- If all attempts fail, mark the row **pending** and re-send it from a background job (e.g. every 10 minutes, for up to 48 hours) with the same `submission_id` and `submitted_at`. After that, alert the office so they can call the visitor.
- Disable the submit button while sending, so one click is one submission.
- Re-sending a submission that already succeeded is harmless (200).

### 7.3 Google Sheets backup (recommended order)

1. Write the Sheet row first, with `submission_id`, `submitted_at` and the status `pending`.
2. Call the CRM.
3. Update the row: `sent` + `enquiry_code`, or `failed` + the HTTP status / error.
4. The retry job re-sends `pending` / `failed` rows (but not 400s).

The Sheet then works as your backup, your delivery log and your retry list. A CRM outage never loses a submission, and a Sheets outage must not block the CRM call (and vice versa).

---

## 8. Spam protection (website side)

The CRM checks and limits every request, but bots should be stopped before they reach it:

1. **CAPTCHA:** Cloudflare Turnstile or Google reCAPTCHA v3 on both the form and the popup. Verify the token **on your server**. If it fails, don't call the CRM.
2. **Honeypot:** a hidden field (e.g. `company_website`). If it's filled, show a normal "thank you" but don't call the CRM.
3. **Basic checks** before sending: required fields, phone format, lengths.
4. Optionally limit submissions per visitor IP on your side.

---

## 9. Code examples

### 9.1 curl (a quick manual test)

```bash
curl -i -X POST "https://nipunacrm.com/api/v1/integrations/website/enquiries" \
  -H "Content-Type: application/json" \
  -H "X-Service-Key: $CRM_WEBSITE_KEY" \
  -d '{"submission_id":"test-001","name":"Website Test","phone":"9000000001","branch_code":"NIT-GNT",
       "enquiry_type":"form","message":"TEST - please ignore"}'
```

### 9.2 Node.js (server side, Node 18+)

```js
import crypto from "node:crypto";

const CRM_URL = "https://nipunacrm.com/api/v1/integrations/website/enquiries";
const RETRY_DELAYS_MS = [0, 1000, 3000, 10000];

/** Build once per submission; keep it (e.g. in the Sheet row) so retries resend the same body. */
export function buildEnquiry(form, kind /* "form" | "call_request" | "whatsapp_request" */) {
  return {
    submission_id: `${kind === "form" ? "web" : "popup"}-${crypto.randomUUID()}`,
    submitted_at: new Date().toISOString(),
    name: form.name?.trim(),
    phone: form.phone?.trim(),
    email: form.email?.trim() || null,
    branch_code: form.branch_code,                    // "NIT-GNT" | "NIT-VIJ"
    enquiry_type: kind,
    marketing_source: form.marketing_source || "organic",
    course_code: form.course_code || null,
    message: form.message?.trim() || null,
    ...(typeof form.whatsapp_consent === "boolean" && { whatsapp_consent: form.whatsapp_consent }),
    utm: form.utm,                                    // { source, medium, campaign, term, content }
    page_url: form.page_url,
    referrer: form.referrer,
  };
}

export async function sendToCrm(body) {
  for (const delay of RETRY_DELAYS_MS) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    let res;
    try {
      res = await fetch(CRM_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Service-Key": process.env.CRM_WEBSITE_KEY },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      continue;                                       // network error / timeout → retry
    }
    const json = await res.json().catch(() => ({}));
    if (res.status === 201 || res.status === 200) return { status: "sent", enquiryCode: json.data.enquiry_code };
    if (res.status === 400) return { status: "invalid", errors: json.error?.details ?? {} };
    if (res.status === 429) return { status: "pending", reason: "rate_limited" };
    if (res.status === 401) return { status: "pending", reason: "bad_key" };   // alert your team
    // 409 / 5xx → retry
  }
  return { status: "pending", reason: "unreachable" };  // background job re-sends with the same body
}
```

### 9.3 PHP (WordPress)

```php
function nipuna_build_enquiry(array $f, string $kind): array {
  return array_filter([
    'submission_id'    => ($kind === 'form' ? 'web-' : 'popup-') . wp_generate_uuid4(),
    'submitted_at'     => gmdate('c'),
    'name'             => trim($f['name'] ?? ''),
    'phone'            => trim($f['phone'] ?? ''),
    'email'            => trim($f['email'] ?? '') ?: null,
    'branch_code'      => $f['branch_code'] ?? null,
    'enquiry_type'     => $kind,
    'marketing_source' => $f['marketing_source'] ?? 'organic',
    'course_code'      => $f['course_code'] ?? null,
    'message'          => trim($f['message'] ?? '') ?: null,
    'whatsapp_consent' => isset($f['whatsapp_consent']) ? (bool) $f['whatsapp_consent'] : null,
    'utm'              => $f['utm'] ?? null,
    'page_url'         => $f['page_url'] ?? null,
  ], fn($v) => $v !== null);
}

function nipuna_send(array $body): array {
  $res = wp_remote_post('https://nipunacrm.com/api/v1/integrations/website/enquiries', [
    'headers' => ['Content-Type' => 'application/json', 'X-Service-Key' => getenv('CRM_WEBSITE_KEY')],
    'body'    => wp_json_encode($body),
    'timeout' => 10,
  ]);
  if (is_wp_error($res)) return ['status' => 'pending'];
  $code = wp_remote_retrieve_response_code($res);
  $json = json_decode(wp_remote_retrieve_body($res), true);
  if ($code === 201 || $code === 200) return ['status' => 'sent', 'enquiry_code' => $json['data']['enquiry_code']];
  if ($code === 400) return ['status' => 'invalid', 'errors' => $json['error']['details'] ?? []];
  return ['status' => 'pending', 'http' => $code];        // retry later with the same body
}
```

---

## 10. Go-live checklist

**Build**

- [ ] Key stored only in a server environment variable (`CRM_WEBSITE_KEY`); not in any front-end file or repo
- [ ] Enquiry form sends `enquiry_type: "form"`; the popup's Call / WhatsApp buttons send `call_request` / `whatsapp_request`
- [ ] Branch is required on the form **and** the popup
- [ ] Course dropdown uses the codes in 4.2 (+ "Not sure yet")
- [ ] `submission_id` and `submitted_at` created once per submission and reused on retries
- [ ] `marketing_source` and UTM captured on landing and kept for the visit
- [ ] Unticked WhatsApp consent checkbox on the form
- [ ] CAPTCHA verified on the server and a honeypot in place
- [ ] Google Sheets row written with `submission_id`, status and `enquiry_code`; retry job for pending rows

**Test against production** (use mobiles `9000000001`–`9000000099`, the name "Website Test" and a message starting "TEST"; tell the CRM team the time you test, and they will mark these enquiries *Test*):

| # | Send | Expect |
|---|---|---|
| 1 | A valid form submission | 201, `received`, an `ENQ-…` code; staff see it in Enquiries |
| 2 | The same body again | 200, same code, `duplicate_submission` |
| 3 | A popup `call_request` with only name, phone, branch | 201; staff see channel "Phone call" |
| 4 | A popup `whatsapp_request` with `marketing_source: "meta_ads"` | 201; staff see source "Meta Ads", channel "WhatsApp" |
| 5 | No / wrong `X-Service-Key` | 401 |
| 6 | `phone: "12345"`, no `branch_code`, no `enquiry_type` | 400 listing `phone`, `branch_code`, `enquiry_type` |
| 7 | `branch_code: "NIT-XYZ"` or `marketing_source: "tv"` | 400 |
| 8 | `course_code: "SOMETHING-ELSE"` | 201 (kept as text for staff) |
| 9 | CAPTCHA failed / honeypot filled | The CRM is **not** called |
| 10 | Simulate the CRM being unreachable (e.g. wrong host in a test build) | The row stays `pending` and is re-sent later with the same `submission_id` |

Please don't run load tests: more than 5 sends from one mobile an hour, or 30 a minute, are refused (429).

---

## 11. Next phase: advertising lead forms

| Source | Plan | What we will need |
|---|---|---|
| Facebook / Instagram Instant Forms | A CRM webhook that receives Meta's lead notification and fetches the lead | A Meta app with the `leads_retrieval` permission (Meta app review), a Page access token from the Page admin, the Page and form IDs, and how each form maps to a branch and course |
| Google Ads lead forms | A separate CRM webhook URL with its own key, in Google's lead-form format | Access to set the webhook URL and key in Google Ads, and the form → branch / course mapping |

**Until these are built** you may forward these leads (e.g. from your Sheet or an automation tool) to the endpoint in this guide:
- `marketing_source`: `meta_ads` or `google_ads`
- `enquiry_type`: `form`
- `submission_id`: the platform's lead ID with a prefix (`meta-<lead id>`, `gads-<lead id>`), so they're never imported twice
- `submitted_at`: the platform's created time
- the campaign / form name in `utm.campaign` / `utm.content`

---

## 12. Questions for you

Please reply with:

1. Your platform: does the site have its own server, or will you use a serverless function? Which one?
2. The final fields on the form and the popup, and how the popup will pick the branch.
3. Which CAPTCHA you will use.
4. Your server's public IP address(es), if fixed. The CRM can then accept calls only from them.
5. A technical contact for key rotation and incidents, and your planned go-live date.

## 13. Support

- Key lost, leaked or needing a change, or anything in this guide unclear: contact the Nipuna CRM owner.
- When reporting a problem, include the `submission_id`, the time, the HTTP status and the error body. **Never send the key** in an email, chat or ticket.
