// Company tax year helpers. A tax year ends on the last day of
// `endMonth` (1-12); the default is the SA tax year (1 Mar - end Feb).
// No imports so the unit tests can run this file directly with Node.

export const DEFAULT_TAX_YEAR_END_MONTH = 2;

export const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const MONTH_FULL_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export type TaxYearRange = { from: string; to: string };

const pad = (n: number) => String(n).padStart(2, "0");

export function normalizeTaxYearEndMonth(value: unknown) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : DEFAULT_TAX_YEAR_END_MONTH;
}

/** Last day of a month (month 1-12), leap years included. */
export function lastDayOfMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The full tax year (first day to last day) containing `dateIso`. */
export function taxYearRange(dateIso: string, endMonth: unknown = DEFAULT_TAX_YEAR_END_MONTH): TaxYearRange {
  const end = normalizeTaxYearEndMonth(endMonth);
  const y = Number(dateIso.slice(0, 4));
  const m = Number(dateIso.slice(5, 7));
  const endYear = m > end ? y + 1 : y;
  const startMonth = end === 12 ? 1 : end + 1;
  const startYear = end === 12 ? endYear : endYear - 1;
  return {
    from: `${startYear}-${pad(startMonth)}-01`,
    to: `${endYear}-${pad(end)}-${pad(lastDayOfMonth(endYear, end))}`,
  };
}

/** The tax year before the one containing `dateIso`. */
export function previousTaxYearRange(dateIso: string, endMonth: unknown = DEFAULT_TAX_YEAR_END_MONTH): TaxYearRange {
  const current = taxYearRange(dateIso, endMonth);
  const y = Number(current.from.slice(0, 4));
  return taxYearRange(`${y - 1}${current.from.slice(4)}`, endMonth);
}

/** "Mar 2026 - Feb 2027" */
export function taxYearLabel(range: TaxYearRange) {
  const part = (iso: string) => `${MONTH_NAMES[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
  return `${part(range.from)} - ${part(range.to)}`;
}

/** Date picker presets for the company's tax year. "This tax year" runs to today. */
export function taxYearPresets(today: string, endMonth: unknown = DEFAULT_TAX_YEAR_END_MONTH) {
  const current = taxYearRange(today, endMonth);
  const last = previousTaxYearRange(today, endMonth);
  return [
    { label: `This tax year (${taxYearLabel(current)})`, from: current.from, to: today },
    { label: `Last tax year (${taxYearLabel(last)})`, from: last.from, to: last.to },
  ];
}
