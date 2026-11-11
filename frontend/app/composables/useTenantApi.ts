/** Plain message for a failed API call when the server sent no error text. */
export function friendlyHttpError(status: number, fallback = "Something went wrong. Please try again.") {
  if (status === 401) return "Your session has expired. Please sign in again.";
  if (status === 403) return "You don't have access to this.";
  if (status === 404) return "This isn't available on the server yet. The API may need a restart or update.";
  if (status === 413) return "That file is too large.";
  if (status >= 500) return "The server had a problem. Please try again.";
  return fallback;
}

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
      throw new Error(data.error || friendlyHttpError(res.status));
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
      throw new Error(data.error || friendlyHttpError(res.status, "Download failed. Please try again."));
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
