<script setup lang="ts">
definePageMeta({ layout: "dashboard", middleware: "auth" });

type Line = { description: string; note: string; qty: number; unitPrice: number; taxable?: boolean; accountId?: string };

const route = useRoute();
const { activeCompanyId, capi, cpatch } = useCompanyApi();
const note = ref<any>(null);
const items = ref<Line[]>([]);
const issueDate = ref("");
const reason = ref("");
const notes = ref("");
const saving = ref("");
const error = ref("");
const id = computed(() => String(route.params.id));

function newLine(): Line {
  return { description: "", note: "", qty: 1, unitPrice: 0, taxable: true };
}

async function load() {
  if (!activeCompanyId.value) return;
  error.value = "";
  try {
    note.value = await capi(`/credit-notes/${id.value}`);
    if (!note.value.draft) {
      await navigateTo(`/dashboard/credit-notes/${id.value}`);
      return;
    }
    items.value = (note.value.items || []).map((i: any) => ({
      description: i.description || "",
      note: i.note || "",
      qty: i.qty ?? 1,
      unitPrice: i.unitPrice ?? 0,
      taxable: i.taxable !== false,
      accountId: i.accountId,
    }));
    issueDate.value = note.value.issueDateIso || note.value.issueDate || "";
    reason.value = note.value.reason || "";
    notes.value = note.value.notes || "";
  } catch (e) {
    error.value = errMsg(e, "Failed to load credit note");
  }
}

async function save(finalize: boolean) {
  saving.value = finalize ? "publish" : "draft";
  error.value = "";
  try {
    const updated = await cpatch<any>(`/credit-notes/${id.value}`, {
      items: items.value,
      issueDate: issueDate.value,
      reason: reason.value,
      notes: notes.value,
      finalize,
    });
    await navigateTo(`/dashboard/credit-notes/${updated.id}`);
  } catch (e) {
    error.value = errMsg(e, "Failed to save credit note");
  } finally {
    saving.value = "";
  }
}

watch([activeCompanyId, id], load, { immediate: true });
</script>

<template>
  <div class="mx-auto w-full max-w-5xl space-y-6">
    <PageHeader title="Edit credit note">
      <template #filters>
        <UButton :to="`/dashboard/credit-notes/${id}`" variant="ghost" color="neutral" icon="i-lucide-arrow-left" aria-label="Back" />
      </template>
      <template v-if="note">
        <UButton variant="soft" :loading="saving === 'draft'" @click="save(false)">Save draft</UButton>
        <UButton icon="i-lucide-check" :loading="saving === 'publish'" @click="save(true)">Publish</UButton>
      </template>
    </PageHeader>
    <UAlert v-if="error" color="error" variant="subtle" :title="error" />
    <div v-if="note" class="space-y-6">
      <div class="grid gap-4 sm:grid-cols-2">
        <UFormField label="Issue date"><UInput v-model="issueDate" type="date" class="w-full" /></UFormField>
        <UFormField label="Reason"><UInput v-model="reason" class="w-full" /></UFormField>
      </div>
      <LineItemsEditor v-model="items" :currency="note.currency" :vat-rate="note.vatRate || 0" :new-line="newLine" />
      <UFormField label="Notes"><UTextarea v-model="notes" :rows="3" class="w-full" /></UFormField>
    </div>
  </div>
</template>
