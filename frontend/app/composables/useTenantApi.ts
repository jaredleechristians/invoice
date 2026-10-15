type CompanyRow = {
  id: string;
  name: string;
  role: string;
};

export function useTenantApi() {
  const { idToken } = useAuth();
  const activeCompanyId = useState<string | null>("active-company-id", () => null);

  async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await idToken();
    if (!token) throw new Error("Sign in required");
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    if (init.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const res = await fetch(`/api/tenant${path}`, { ...init, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || res.statusText || "Request failed");
    }
    return data as T;
  }

  async function apiFetchBlob(path: string): Promise<Blob> {
    const token = await idToken();
    if (!token) throw new Error("Sign in required");
    const res = await fetch(`/api/tenant${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || res.statusText || "Download failed");
    }
    return res.blob();
  }

  function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function bootstrap() {
    return apiFetch<{ companies: CompanyRow[]; created: boolean }>("/bootstrap", {
      method: "POST",
      body: "{}",
    });
  }

  async function loadMe() {
    return apiFetch<{ user: { uid: string; email: string }; companies: CompanyRow[] }>(
      "/me"
    );
  }

  function setActiveCompany(id: string | null) {
    activeCompanyId.value = id;
    if (id) localStorage.setItem("activeCompanyId", id);
    else localStorage.removeItem("activeCompanyId");
  }

  function restoreActiveCompany(companies: CompanyRow[]) {
    const saved = localStorage.getItem("activeCompanyId");
    const pick = companies.find((c) => c.id === saved) || companies[0];
    if (pick) activeCompanyId.value = pick.id;
  }

  return {
    activeCompanyId,
    apiFetch,
    apiFetchBlob,
    downloadBlob,
    bootstrap,
    loadMe,
    setActiveCompany,
    restoreActiveCompany,
  };
}
