/**
 * Config-driven report exports. Add a report by appending to REPORT_EXPORTS
 * (a function that turns the /reports payload into a table) and a format by
 * appending to EXPORT_FORMATS (a serializer). The Reports page builds its
 * Export menu from these lists.
 */

export type ExportTable = { headers: string[]; rows: (string | number)[][] };

/** The parts of the /reports payload the exports read. */
export type ReportsPayload = {
  range: { from: string; to: string; asOf: string };
  incomeByMonth: Record<string, { month: string; amount: number }[]>;
  invoicedByMonth: Record<string, { month: string; amount: number }[]>;
  incomeByCustomer: Record<string, { customerName: string; received: number; invoiced: number; invoiceCount: number }[]>;
  agedReceivables: Record<string, { rows: Record<string, any>[]; totals: Record<string, number> }>;
  outstandingInvoices: { invoiceNumber: string; customerName: string; currency: string; issueDate: string; dueDate: string; total: number; outstanding: number; daysOverdue: number }[];
  expensesByCategory: Record<string, { rows: { categoryName: string; amount: number; count: number }[]; total: number }>;
  profitAndLoss: Record<string, { income: number; expenses: number; net: number; expenseLines: { categoryName: string; amount: number }[] }>;
};

export type ReportExport = {
  id: string;
  label: string;
  icon: string;
  build: (data: ReportsPayload) => ExportTable;
};

export const AGING_BUCKETS = ["current", "1-30", "31-60", "61-90", "90+"];

function byMonth(src: Record<string, { month: string; amount: number }[]>): ExportTable {
  const rows: (string | number)[][] = [];
  for (const [cur, list] of Object.entries(src)) for (const r of list) rows.push([cur, r.month, r.amount]);
  return { headers: ["Currency", "Month", "Amount"], rows };
}

export const REPORT_EXPORTS: ReportExport[] = [
  {
    id: "income-by-month",
    label: "Income by month",
    icon: "i-lucide-trending-up",
    build: (d) => byMonth(d.incomeByMonth),
  },
  {
    id: "income-by-customer",
    label: "Income by customer",
    icon: "i-lucide-users",
    build: (d) => ({
      headers: ["Currency", "Customer", "Received", "Invoiced", "Invoices"],
      rows: Object.entries(d.incomeByCustomer).flatMap(([cur, list]) =>
        list.map((r) => [cur, r.customerName, r.received, r.invoiced, r.invoiceCount])
      ),
    }),
  },
  {
    id: "invoiced-by-month",
    label: "Invoiced by month",
    icon: "i-lucide-file-text",
    build: (d) => byMonth(d.invoicedByMonth),
  },
  {
    id: "outstanding-invoices",
    label: "Outstanding invoices",
    icon: "i-lucide-hourglass",
    build: (d) => ({
      headers: ["Invoice", "Customer", "Currency", "Issued", "Due", "Total", "Outstanding", "Days overdue"],
      rows: d.outstandingInvoices.map((i) => [i.invoiceNumber, i.customerName, i.currency, i.issueDate, i.dueDate, i.total, i.outstanding, i.daysOverdue]),
    }),
  },
  {
    id: "aged-receivables",
    label: "Aged receivables",
    icon: "i-lucide-calendar-clock",
    build: (d) => ({
      headers: ["Currency", "Customer", ...AGING_BUCKETS.map((b) => (b === "current" ? "Current" : `${b} days`)), "Total"],
      rows: Object.entries(d.agedReceivables).flatMap(([cur, v]) => [
        ...v.rows.map((r) => [cur, String(r.customerName ?? ""), ...AGING_BUCKETS.map((b) => Number(r[b] || 0)), Number(r.total || 0)]),
        [cur, "Total", ...AGING_BUCKETS.map((b) => Number(v.totals[b] || 0)), Number(v.totals.total || 0)],
      ]),
    }),
  },
  {
    id: "expenses-by-category",
    label: "Expenses by category",
    icon: "i-lucide-receipt",
    build: (d) => ({
      headers: ["Currency", "Category", "Amount", "Count"],
      rows: Object.entries(d.expensesByCategory).flatMap(([cur, v]) => v.rows.map((r) => [cur, r.categoryName, r.amount, r.count])),
    }),
  },
  {
    id: "profit-and-loss",
    label: "Profit & loss",
    icon: "i-lucide-scale",
    build: (d) => ({
      headers: ["Currency", "Line", "Amount"],
      rows: Object.entries(d.profitAndLoss).flatMap(([cur, v]) => [
        [cur, "Income (payments received)", v.income],
        ...v.expenseLines.map((l) => [cur, `Expense: ${l.categoryName}`, l.amount]),
        [cur, "Total expenses", v.expenses],
        [cur, "Net", v.net],
      ]),
    }),
  },
];

/** Every report stacked into one table, prefixed with a "Report" column. */
export const ALL_REPORTS_EXPORT: ReportExport = {
  id: "all",
  label: "All reports (combined)",
  icon: "i-lucide-files",
  build: (d) => {
    const tables = REPORT_EXPORTS.map((r) => ({ label: r.label, t: r.build(d) }));
    const width = Math.max(...tables.map(({ t }) => t.headers.length));
    const rows: (string | number)[][] = [];
    for (const { label, t } of tables) {
      rows.push([label, ...t.headers]);
      for (const r of t.rows) rows.push([label, ...r]);
    }
    return { headers: ["Report", ...Array.from({ length: width }, (_, i) => `Column ${i + 1}`)], rows };
  },
};

export type ExportFormat = {
  id: string;
  label: string;
  extension: string;
  mime: string;
  serialize: (table: ExportTable) => string | Blob;
};

function csvCell(v: string | number) {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(table: ExportTable) {
  return [table.headers, ...table.rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/** Add PDF/XLSX here later; the Export menu lists one group per format. */
export const EXPORT_FORMATS: ExportFormat[] = [
  { id: "csv", label: "CSV", extension: "csv", mime: "text/csv;charset=utf-8", serialize: toCsv },
];

export function exportFilename(report: ReportExport, format: ExportFormat, range: { from: string; to: string }) {
  return `${report.id}_${range.from}_to_${range.to}.${format.extension}`;
}

export function downloadReport(data: ReportsPayload, report: ReportExport, format: ExportFormat) {
  const out = format.serialize(report.build(data));
  const blob = out instanceof Blob ? out : new Blob([out], { type: format.mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = exportFilename(report, format, data.range);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
