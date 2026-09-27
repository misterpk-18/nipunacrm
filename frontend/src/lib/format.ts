/** Display helpers. Money arrives as strings ("27000.00"); dates as ISO strings; shown in IST. */

const TZ = "Asia/Kolkata";
const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const inrPaise = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2 });

/** ₹27,000 (whole rupees) or ₹27,000.50 when paise are present. Formatting only — never sum these as floats. */
export function money(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = typeof value === "number" ? value : Number(value);
  if (Number.isNaN(n)) return String(value);
  return Number.isInteger(n) ? inr.format(n) : inrPaise.format(n);
}

/** Sum money strings exactly (paise as integers). */
export function sumMoney(values: (string | null | undefined)[]): string {
  const paise = values.reduce((acc, v) => acc + (v ? Math.round(Number(v) * 100) : 0), 0);
  return (paise / 100).toFixed(2);
}

export function date(value: string | null | undefined): string {
  if (!value) return "—";
  const d = value.length === 10 ? new Date(`${value}T00:00:00+05:30`) : new Date(value);
  return d.toLocaleDateString("en-IN", { timeZone: TZ, day: "2-digit", month: "short", year: "numeric" });
}

export function dateTime(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-IN", {
    timeZone: TZ,
    day: "2-digit",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "in 3h", "2d ago" — for follow-ups and SLA deadlines. */
export function relative(value: string | null | undefined): string {
  if (!value) return "—";
  const diff = new Date(value).getTime() - Date.now();
  const abs = Math.abs(diff);
  const minutes = Math.round(abs / 60_000);
  const text = minutes < 60 ? `${minutes}m` : minutes < 48 * 60 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / 1440)}d`;
  return diff >= 0 ? `in ${text}` : `${text} ago`;
}

export function isPast(value: string | null | undefined): boolean {
  return Boolean(value && new Date(value).getTime() < Date.now());
}

/** +919876500001 → +91 98765 •••01 (list views mask phones; detail views show them in full). */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return "—";
  const digits = phone.replace(/\D/g, "").slice(-10);
  if (digits.length < 10) return phone;
  return `+91 ${digits.slice(0, 5)} •••${digits.slice(8)}`;
}

export function phone(value: string | null | undefined): string {
  if (!value) return "—";
  const digits = value.replace(/\D/g, "").slice(-10);
  return digits.length === 10 ? `+91 ${digits.slice(0, 5)} ${digits.slice(5)}` : value;
}

/** Datetime-local input value (IST) ⇄ ISO with offset, for forms. */
export function toLocalInput(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(new Date(value).getTime() + 5.5 * 3600_000);
  return d.toISOString().slice(0, 16);
}

export function fromLocalInput(value: string): string | null {
  return value ? `${value}:00+05:30` : null;
}

export function todayIST(): string {
  return new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
}
