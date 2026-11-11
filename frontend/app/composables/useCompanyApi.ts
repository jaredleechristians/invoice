/** Fetch helpers scoped to the active company: capi("/invoices") → /api/tenant/companies/:id/invoices */
export function useCompanyApi() {
  const { activeCompanyId, apiFetch, apiFetchBlob, downloadBlob } = useTenantApi();

  function base() {
    if (!activeCompanyId.value) throw new Error("No active company");
    return `/companies/${activeCompanyId.value}`;
  }

  function capi<T>(path: string, init: RequestInit = {}) {
    return apiFetch<T>(`${base()}${path}`, init);
  }

  function cpost<T>(path: string, body: unknown = {}) {
    return capi<T>(path, { method: "POST", body: JSON.stringify(body) });
  }

  function cpatch<T>(path: string, body: unknown = {}) {
    return capi<T>(path, { method: "PATCH", body: JSON.stringify(body) });
  }

  function cdelete<T>(path: string) {
    return capi<T>(path, { method: "DELETE" });
  }

  async function cdownload(path: string, filename: string) {
    const blob = await apiFetchBlob(`${base()}${path}`);
    downloadBlob(blob, filename);
  }

  async function copen(path: string) {
    const blob = await apiFetchBlob(`${base()}${path}`);
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  return { activeCompanyId, capi, cpost, cpatch, cdelete, cdownload, copen };
}

export function errMsg(e: unknown, fallback = "Something went wrong") {
  return e instanceof Error ? e.message : fallback;
}
