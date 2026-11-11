// Read-only: payment details derived from bank accounts shown on invoices (manage them in Settings > Bank accounts).
export type BankAccount = { id?: string; label: string; currency: string; details: string };

export type CompanySettings = {
  id: string;
  name: string;
  legalName: string;
  logoDataUrl: string;
  email: string;
  phone: string;
  website: string;
  address: string;
  registrationNumber: string;
  taxNumber: string;
  vatRegistered: boolean;
  vatNumber: string;
  vatRate: number;
  taxYearEndMonth?: number;
  invoicePrefix: string;
  invoiceNextNumber: number;
  quotePrefix: string;
  quoteNextNumber: number;
  defaultCurrency: string;
  currencies: string[];
  paymentTermsDays: number;
  quoteValidDays: number;
  defaultNotes: string;
  legal: string;
  footer: string;
  bankAccounts: BankAccount[];
  role: string;
};

/** Active company settings, cached per company id. */
export function useCompany() {
  const { activeCompanyId, apiFetch } = useTenantApi();
  const company = useState<CompanySettings | null>("active-company", () => null);
  const loading = useState("active-company-loading", () => false);

  const role = computed(() => company.value?.role || "member");
  const isAdmin = computed(() => ["owner", "admin"].includes(role.value));
  const currencies = computed(() => {
    const list = company.value?.currencies?.length ? company.value.currencies : ["ZAR", "USD"];
    const def = company.value?.defaultCurrency || "ZAR";
    return list.includes(def) ? list : [def, ...list];
  });

  async function refresh() {
    if (!activeCompanyId.value) return null;
    loading.value = true;
    try {
      company.value = await apiFetch<CompanySettings>(`/companies/${activeCompanyId.value}`);
      return company.value;
    } finally {
      loading.value = false;
    }
  }

  async function ensure() {
    if (company.value && company.value.id === activeCompanyId.value) return company.value;
    return refresh();
  }

  return { company, loading, role, isAdmin, currencies, refresh, ensure };
}
