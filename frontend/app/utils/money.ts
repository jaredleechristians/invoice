import { DEFAULT_TAX_YEAR_END_MONTH, taxYearPresets } from "./taxYear";

export const CURRENCIES = ["ZAR", "USD", "EUR", "GBP"] as const;

export type MoneyMap = Record<string, number>;

export function formatCurrency(amount: number | string | null | undefined, currency = "ZAR") {
  const n = Number(amount) || 0;
  try {
    return new Intl.NumberFormat("en-ZA", {
      style: "currency",
      currency: currency || "ZAR",
      minimumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}

export function round2(n: number) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

export function lineTotal(item: { qty?: number | string; unitPrice?: number | string }) {
  return round2((Number(item.qty) || 0) * (Number(item.unitPrice) || 0));
}

export function docTotals(items: { qty?: number | string; unitPrice?: number | string; taxable?: boolean }[], vatRate = 0) {
  let subtotal = 0;
  let taxable = 0;
  for (const i of items) {
    const a = lineTotal(i);
    subtotal += a;
    if (i.taxable !== false) taxable += a;
  }
  subtotal = round2(subtotal);
  const taxTotal = vatRate > 0 ? round2((taxable * vatRate) / 100) : 0;
  return { subtotal, taxTotal, total: round2(subtotal + taxTotal) };
}

export function formatDate(value?: string | null) {
  if (!value) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return value;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

export function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function addDays(iso: string, days: number) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return "";
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return d.toISOString().slice(0, 10);
}

export const STATUS_COLORS: Record<string, "success" | "error" | "warning" | "neutral" | "info" | "primary"> = {
  paid: "success",
  overdue: "error",
  partially_paid: "warning",
  unpaid: "info",
  draft: "neutral",
  void: "neutral",
  sent: "info",
  accepted: "success",
  declined: "error",
  converted: "primary",
  expired: "warning",
  issued: "success",
};

const STATUS_LABELS: Record<string, string> = {
  open: "Open",
  draft: "Draft",
  unpaid: "Unpaid",
  partially_paid: "Partially paid",
  overdue: "Overdue",
  paid: "Paid",
  void: "Void",
  voided: "Void",
  sent: "Sent",
  accepted: "Accepted",
  declined: "Declined",
  converted: "Converted",
  expired: "Expired",
  issued: "Issued",
};

/** Human label for an invoice/quote status, e.g. "partially_paid" → "Partially paid". */
export function statusLabel(s?: string) {
  const key = String(s || "");
  if (STATUS_LABELS[key]) return STATUS_LABELS[key];
  const text = key.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  bank_transfer: "Bank transfer (EFT)",
  cash: "Cash",
  card: "Card",
  paypal: "PayPal",
  wise: "Wise",
  paystack: "Paystack",
  other: "Other",
};

/** Read a File as a data URL (used for logo + receipts). */
export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * Common reporting ranges (ISO dates, inclusive), relative to `today`.
 * Tax year presets follow the company's tax year end month (default Feb, SA).
 */
export function datePresets(today = todayIso(), taxYearEndMonth: unknown = DEFAULT_TAX_YEAR_END_MONTH) {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const pad = (n: number) => String(n).padStart(2, "0");
  // First day of the month 11 months ago -> 12 calendar months including this one.
  const back = new Date(Date.UTC(y, m - 1 - 11, 1));
  return [
    { label: "This month", from: `${today.slice(0, 7)}-01`, to: today },
    { label: "This year", from: `${y}-01-01`, to: today },
    ...taxYearPresets(today, taxYearEndMonth),
    { label: "Last 12 months", from: `${back.getUTCFullYear()}-${pad(back.getUTCMonth() + 1)}-01`, to: today },
  ];
}


/** Toast when publishing an invoice that exceeds the customer's credit limit (warn only). */
export function notifyCreditLimitWarning(doc?: { creditLimitWarning?: { message?: string } } | null) {
  const message = doc?.creditLimitWarning?.message;
  if (!message) return;
  useToast().add({ title: "Over the credit limit", description: message, color: "warning", icon: "i-lucide-triangle-alert" });
}
