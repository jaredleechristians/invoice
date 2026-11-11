<script setup lang="ts">
// Personal API keys for the current company. The full key is shown once.
import { formatDate } from "~/utils/money";

type ApiKey = {
  id: string;
  name: string;
  prefix: string;
  scope: "read" | "read_write";
  userEmail: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  status: "active" | "revoked" | "expired";
};

const { activeCompanyId, capi, cpost } = useCompanyApi();
const { isAdmin } = useCompany();
const toast = useToast();

const keys = ref<ApiKey[]>([]);
const error = ref("");
const loading = ref(false);
const showInactive = ref(false);
const visible = computed(() => (showInactive.value ? keys.value : keys.value.filter((k) => k.status === "active")));
const inactiveCount = computed(() => keys.value.filter((k) => k.status !== "active").length);

const SCOPES = [
  { label: "Read only", value: "read" },
  { label: "Read & write (also publish, void and delete)", value: "read_write" },
];
const EXPIRY = [
  { label: "Never", value: "never" },
  { label: "30 days", value: "30" },
  { label: "90 days", value: "90" },
  { label: "365 days", value: "365" },
];

async function load() {
  if (!activeCompanyId.value) return;
  loading.value = true;
  error.value = "";
  try {
    keys.value = (await capi<{ keys: ApiKey[] }>("/api-keys")).keys;
  } catch (e) {
    error.value = errMsg(e);
  } finally {
    loading.value = false;
  }
}
watch(activeCompanyId, load, { immediate: true });

const form = reactive({ open: false, name: "", scope: "read", expiry: "never", saving: false, error: "", key: "", copied: false });
function openCreate() {
  Object.assign(form, { open: true, name: "", scope: "read", expiry: "never", saving: false, error: "", key: "", copied: false });
}
async function create() {
  form.saving = true;
  form.error = "";
  try {
    const res = await cpost<ApiKey & { key: string }>("/api-keys", { name: form.name, scope: form.scope, expiresInDays: form.expiry === "never" ? null : Number(form.expiry) });
    form.key = res.key;
    await load();
  } catch (e) {
    form.error = errMsg(e);
  } finally {
    form.saving = false;
  }
}
async function copy() {
  try {
    await navigator.clipboard.writeText(form.key);
    form.copied = true;
  } catch {
    toast.add({ title: "Copy failed", description: "Select the key and copy it manually.", color: "error" });
  }
}
function closeCreate() {
  form.key = "";
  form.open = false;
}

async function revoke(k: ApiKey) {
  if (!confirm(`Revoke "${k.name}"? Anything using it stops working.`)) return;
  try {
    await cpost(`/api-keys/${k.id}/revoke`);
    toast.add({ title: "Key revoked", description: k.name, color: "success", icon: "i-lucide-check" });
    await load();
  } catch (e) {
    error.value = errMsg(e);
  }
}

const when = (d: string | null) => (d ? formatDate(d.slice(0, 10)) : "Never");
</script>

<template>
  <UCard id="api-keys">
    <template #header>
      <div class="flex items-center justify-between gap-2">
        <span class="font-medium">API keys</span>
        <UButton size="xs" variant="soft" icon="i-lucide-plus" @click="openCreate">Create key</UButton>
      </div>
    </template>
    <p class="mb-4 text-sm text-muted">
      For scripts, integrations and the MCP server. A key works only for this company and acts as you.
      Keys can't change settings, bank accounts or members.
      <template v-if="isAdmin">You see everyone's keys and can revoke them.</template>
      Company ID: <code class="text-xs">{{ activeCompanyId }}</code>
    </p>
    <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-circle-alert" :title="error" class="mb-4" />

    <div v-if="visible.length" class="divide-y divide-default rounded-lg border border-default">
      <div v-for="k in visible" :key="k.id" class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
        <UIcon name="i-lucide-key-round" class="size-4 shrink-0 text-dimmed" />
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-medium text-highlighted">
            {{ k.name }} <code class="ml-1 text-xs font-normal text-dimmed">{{ k.prefix }}…</code>
          </p>
          <p class="truncate text-xs text-dimmed">
            {{ isAdmin && k.userEmail ? `${k.userEmail} · ` : "" }}Created {{ when(k.createdAt) }} · Last used {{ k.lastUsedAt ? when(k.lastUsedAt) : "never" }} · {{ k.expiresAt ? `Expires ${when(k.expiresAt)}` : "No expiry" }}
          </p>
        </div>
        <UBadge :color="k.scope === 'read_write' ? 'warning' : 'neutral'" variant="subtle" size="sm">{{ k.scope === "read_write" ? "Read & write" : "Read only" }}</UBadge>
        <UBadge v-if="k.status !== 'active'" color="error" variant="subtle" size="sm">{{ k.status === "revoked" ? "Revoked" : "Expired" }}</UBadge>
        <UButton v-else size="xs" variant="ghost" color="error" @click="revoke(k)">Revoke</UButton>
      </div>
    </div>
    <p v-else-if="!loading" class="text-sm text-dimmed">No active keys.</p>
    <UButton v-if="inactiveCount" variant="link" size="xs" color="neutral" class="mt-2 px-0" @click="showInactive = !showInactive">
      {{ showInactive ? "Hide" : "Show" }} revoked and expired ({{ inactiveCount }})
    </UButton>

    <UModal v-model:open="form.open" :title="form.key ? 'Your new API key' : 'Create API key'" :dismissible="!form.key" @update:open="(o: boolean) => !o && closeCreate()">
      <template #body>
        <div v-if="form.key" class="space-y-3">
          <UAlert color="warning" variant="subtle" icon="i-lucide-triangle-alert" title="Copy it now. You won't see this key again." />
          <div class="flex gap-2">
            <UInput :model-value="form.key" readonly class="flex-1 font-mono" @focus="($event.target as HTMLInputElement).select()" />
            <UButton :icon="form.copied ? 'i-lucide-check' : 'i-lucide-copy'" @click="copy">{{ form.copied ? "Copied" : "Copy" }}</UButton>
          </div>
          <p class="text-xs text-dimmed">Send it as <code>Authorization: Bearer &lt;key&gt;</code>. Lost it? Revoke it and create a new one.</p>
        </div>
        <form v-else id="api-key-form" class="space-y-4" @submit.prevent="create">
          <UAlert v-if="form.error" color="error" variant="subtle" icon="i-lucide-circle-alert" :title="form.error" />
          <UFormField label="Name" required><UInput v-model="form.name" placeholder="e.g. Zapier" autofocus class="w-full" /></UFormField>
          <UFormField label="Access"><AppSelect v-model="form.scope" :options="SCOPES" /></UFormField>
          <UFormField label="Expires"><AppSelect v-model="form.expiry" :options="EXPIRY" /></UFormField>
        </form>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton v-if="form.key" @click="closeCreate">Done</UButton>
          <template v-else>
            <UButton variant="ghost" color="neutral" @click="form.open = false">Cancel</UButton>
            <UButton type="submit" form="api-key-form" :loading="form.saving" :disabled="!form.name.trim()">Create key</UButton>
          </template>
        </div>
      </template>
    </UModal>
  </UCard>
</template>
