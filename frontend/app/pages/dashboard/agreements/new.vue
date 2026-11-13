<script setup lang="ts">
import { todayIso } from "~/utils/money";

definePageMeta({ layout: "dashboard", middleware: "auth" });

type Customer = { id: string; name: string; currency?: string };
type Service = { id: string; name: string; unitPrice: number; currency?: string; kind: string };

const { capi, cpost } = useCompanyApi();
const { currencies, ensure } = useCompany();
const toast = useToast();

const customers = ref<Customer[]>([]);
const services = ref<Service[]>([]);
const error = ref("");
const saving = ref(false);
const blank = () => ({
  name: "",
  customerId: "",
  serviceId: "",
  startDate: todayIso(),
  endDate: "",
  period: "month" as const,
  hours: 10 as number | string,
  fee: 0 as number | string,
  rate: "" as number | string | null,
  overageRate: "" as number | string | null,
  currency: "",
  autoPublish: false,
  rolloverMode: "expire" as const,
  limitHours: "" as number | string | null,
});
const form = reactive(blank());

function payload() {
  return {
    name: form.name,
    customerId: form.customerId,
    serviceId: form.serviceId,
    startDate: form.startDate,
    endDate: form.endDate || null,
    period: form.period,
    hours: Number(form.hours),
    fee: Number(form.fee),
    rate: form.rate === "" || form.rate == null ? undefined : Number(form.rate),
    overageRate: form.overageRate === "" || form.overageRate == null ? null : Number(form.overageRate),
    currency: form.currency || undefined,
    autoPublish: form.autoPublish,
    rolloverPolicy: {
      mode: form.rolloverMode,
      limitHours: form.rolloverMode === "rollover" && form.limitHours !== "" && form.limitHours != null ? Number(form.limitHours) : null,
    },
  };
}

async function load() {
  await ensure();
  const [c, p] = await Promise.all([
    capi<{ customers: Customer[] }>("/customers"),
    capi<{ products: Service[] }>("/products"),
  ]);
  customers.value = c.customers;
  services.value = p.products.filter((x) => x.kind !== "product");
}

async function save(activate = false) {
  saving.value = true;
  error.value = "";
  try {
    const created = await cpost<{ id: string }>("/agreements", payload());
    if (activate) await cpost(`/agreements/${created.id}/activate`);
    toast.add({ title: activate ? "Agreement activated" : "Draft agreement saved", color: "success", icon: "i-lucide-check" });
    await navigateTo(`/dashboard/agreements/${created.id}`);
  } catch (e) {
    error.value = errMsg(e, "Could not save the agreement");
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="mx-auto max-w-3xl space-y-6">
    <PageHeader title="New agreement" info="Save as a draft first, or activate to start generating recurring invoices for periods that have already begun." />
    <UCard>
      <AgreementForm v-model="form" :customers="customers" :services="services" :currencies="currencies" :error="error" />
      <template #footer>
        <div class="flex flex-wrap justify-end gap-2">
          <UButton variant="ghost" color="neutral" to="/dashboard/agreements">Cancel</UButton>
          <UButton color="neutral" variant="outline" :loading="saving" :disabled="!form.customerId || !form.serviceId || !form.name" @click="save(false)">Save draft</UButton>
          <UButton :loading="saving" :disabled="!form.customerId || !form.serviceId || !form.name" @click="save(true)">Save and activate</UButton>
        </div>
      </template>
    </UCard>
  </div>
</template>
