// Per-page navbar title/info, set by <PageHeader> and rendered by layouts/dashboard.vue.
export type PageHeaderState = { title: string; info: string; owner: number };

export function usePageHeader() {
  return useState<PageHeaderState>("page-header", () => ({ title: "", info: "", owner: 0 }));
}
