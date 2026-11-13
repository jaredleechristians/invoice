<script setup lang="ts">
import { agreementFormLines, agreementLinesPayload, type AgreementFormLine, type AgreementLineInput } from "~/utils/agreementValue";

definePageMeta({ layout: "dashboard", middleware: "auth" });

type Customer = { id: string; name: string; currency?: string };
type Service = { id: string; name: string; unitPrice: number; currency?: string; kind: string };
type Agreement = {
  id: string;
  name: string;
  status: string;
  customerId: string;
  serviceId: string;
  lines?: AgreementLineInput[];
  startDate: string;
  endDate?: string;
  period: "month" | "quarter";
  hours: number;
  fee: number;
  rate?: number | null;
  overageRate?: number | null;
  currency: string;
  autoPublish: boolean;
  rolloverPolicy?: { mode?: "expire" | "rollover"; limitHours?: number | null };
};

const route = useRoute();
const { capi, cpatch } = useCompanyApi();
const { currencies, ensure } = useCompany();
const toast = useToast();

const customers = ref<Customer[]>([]);
const services = ref<Service[]>([]);
const error = ref("");
const loading = ref(true);
const saving = ref(false);
const form = reactive({
  name: "",
  customerId: "",
  lines: [] as AgreementFormLine[],
  startDate: "",
  endDate: "",
  period: "month" as "month" | "quarter",
  currency: "",
  autoPublish: false,
  rolloverMode: "expire" as "expire" | "rollover",
  limitHours: "" as number | string | null,
});
const locked = ref(false);
const canSave = computed(() => Boolean(form.name && form.customerId && form.lines.length && form.lines.every((l) => l.serviceId)));
const id = computed(() => String(route.params.id || ""));

async function load() {
  loading.value = true;
  error.value = "";
  try {
    await ensure();
    const [a, c, p] = await Promise.all([
      capi<Agreement>(`/agreements/${id.value}`),
      capi<{ customers: Customer[] }>("/customers"),
      capi<{ products: Service[] }>("/products"),
    ]);
    customers.value = c.customers;
    services.value = p.products.filter((x) => x.kind !== "product");
    locked.value = a.status !== "draft";
    Object.assign(form, {
      name: a.name,
      customerId: a.customerId,
      lines: agreementFormLines(a),
      startDate: a.startDate,
      endDate: a.endDate || "",
      period: a.period || "month",
      currency: a.currency || "",
      autoPublish: Boolean(a.autoPublish),
      rolloverMode: a.rolloverPolicy?.mode === "rollover" ? "rollover" : "expire",
      limitHours: a.rolloverPolicy?.limitHours ?? "",
    });
  } catch (e) {
    error.value = errMsg(e, "Failed to load the agreement");
  } finally {
    loading.value = false;
  }
}

async function save() {
  saving.value = true;
  error.value = "";
  try {
    await cpatch(`/agreements/${id.value}`, {
      name: form.name,
      customerId: form.customerId,
      lines: agreementLinesPayload(form.lines),
      startDate: form.startDate,
      endDate: form.endDate || null,
      period: form.period,
      currency: form.currency || undefined,
      autoPublish: form.autoPublish,
      rolloverPolicy: {
        mode: form.rolloverMode,
        limitHours: form.rolloverMode === "rollover" && form.limitHours !== "" && form.limitHours != null ? Number(form.limitHours) : null,
      },
    });
    toast.add({ title: "Agreement updated", color: "success", icon: "i-lucide-check" });
    await navigateTo(`/dashboard/agreements/${id.value}`);
  } catch (e) {
    error.value = errMsg(e, "Could not save the agreement");
  } finally {
    saving.value = false;
  }
}

watch([id, useDataVersion()], load, { immediate: true });
</script>

<template>
  <div class="mx-auto max-w-3xl space-y-6">
    <PageHeader title="Edit agreement" />
    <UCard v-if="!loading">
      <AgreementForm v-model="form" :customers="customers" :services="services" :currencies="currencies" :error="error" :locked="locked" />
      <template #footer>
        <div class="flex flex-wrap justify-end gap-2">
          <UButton variant="ghost" color="neutral" :to="`/dashboard/agreements/${id}`">Cancel</UButton>
          <UButton :loading="saving" :disabled="!canSave" @click="save">Save</UButton>
        </div>
      </template>
    </UCard>
    <p v-else class="text-sm text-dimmed">Loading…</p>
  </div>
</template>
