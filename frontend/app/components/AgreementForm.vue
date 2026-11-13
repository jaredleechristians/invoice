<script setup lang="ts">
import { CURRENCIES } from "~/utils/money";

type Customer = { id: string; name: string; currency?: string };
type Service = { id: string; name: string; unitPrice: number; currency?: string; kind: string };

const props = defineProps<{
  modelValue: {
    name: string;
    customerId: string;
    serviceId: string;
    startDate: string;
    endDate: string;
    period: "month" | "quarter";
    hours: number | string;
    fee: number | string;
    rate: number | string | null;
    overageRate: number | string | null;
    currency: string;
    autoPublish: boolean;
    rolloverMode: "expire" | "rollover";
    limitHours: number | string | null;
  };
  customers: Customer[];
  services: Service[];
  error?: string;
  locked?: boolean;
  currencies?: string[];
}>();

const emit = defineEmits(["update:modelValue"]);
const form = computed({
  get: () => props.modelValue,
  set: (v) => emit("update:modelValue", v),
});

const currencyOptions = computed(() => {
  const list = props.currencies?.length ? props.currencies : [...CURRENCIES];
  return list.map((c) => ({ label: c, value: c }));
});

function set<K extends keyof typeof props.modelValue>(key: K, value: (typeof props.modelValue)[K]) {
  emit("update:modelValue", { ...props.modelValue, [key]: value });
}

watch(
  () => [props.modelValue.customerId, props.modelValue.serviceId],
  () => {
    const f = props.modelValue;
    const customer = props.customers.find((c) => c.id === f.customerId);
    const service = props.services.find((s) => s.id === f.serviceId);
    const patch: Partial<typeof f> = {};
    if (!f.name && customer && service) patch.name = `${service.name} — ${customer.name}`;
    if (!f.currency && (customer?.currency || service?.currency)) patch.currency = customer?.currency || service?.currency || "";
    if ((f.fee === "" || f.fee === 0 || f.fee == null) && service && service.unitPrice) patch.fee = service.unitPrice;
    if (Object.keys(patch).length) emit("update:modelValue", { ...f, ...patch });
  }
);
</script>

<template>
  <div class="space-y-6">
    <UAlert v-if="error" color="error" variant="subtle" :title="error" />
    <div class="grid gap-4 sm:grid-cols-2">
      <UFormField label="Name" required class="sm:col-span-2">
        <UInput :model-value="form.name" class="w-full" @update:model-value="set('name', String($event || ''))" />
      </UFormField>
      <UFormField label="Customer" required>
        <AppSelect
          :model-value="form.customerId"
          :disabled="locked"
          searchable
          placeholder="Select a customer"
          :options="customers.map((c) => ({ label: c.name, value: c.id }))"
          @update:model-value="set('customerId', String($event || ''))"
        />
      </UFormField>
      <UFormField label="Billable service" required>
        <AppSelect
          :model-value="form.serviceId"
          searchable
          placeholder="Select a service"
          :options="services.map((s) => ({ label: s.name, value: s.id }))"
          @update:model-value="set('serviceId', String($event || ''))"
        />
      </UFormField>
      <UFormField label="Start date" required>
        <UInput :model-value="form.startDate" type="date" class="w-full" :disabled="locked" @update:model-value="set('startDate', String($event || ''))" />
      </UFormField>
      <UFormField label="End date" hint="Leave blank for an open-ended agreement">
        <UInput :model-value="form.endDate" type="date" class="w-full" @update:model-value="set('endDate', String($event || ''))" />
      </UFormField>
      <UFormField label="Period">
        <AppSelect
          :model-value="form.period"
          :disabled="locked"
          :options="[{ label: 'Calendar month', value: 'month' }, { label: 'Calendar quarter', value: 'quarter' }]"
          @update:model-value="set('period', ($event || 'month') as 'month' | 'quarter')"
        />
      </UFormField>
      <UFormField label="Currency">
        <AppSelect :model-value="form.currency" :options="currencyOptions" @update:model-value="set('currency', String($event || ''))" />
      </UFormField>
      <UFormField label="Included hours" required>
        <UInput :model-value="form.hours" type="number" min="0" step="0.25" class="w-full" @update:model-value="set('hours', $event as number | string)" />
      </UFormField>
      <UFormField label="Period fee" required>
        <UInput :model-value="form.fee" type="number" min="0" step="0.01" class="w-full" @update:model-value="set('fee', $event as number | string)" />
      </UFormField>
      <UFormField label="Standard hourly rate" hint="Used for overage if no overage rate is set">
        <UInput :model-value="form.rate as number | string" type="number" min="0" step="0.01" class="w-full" @update:model-value="set('rate', $event as number | string)" />
      </UFormField>
      <UFormField label="Overage rate" hint="Optional. Falls back to the standard rate.">
        <UInput :model-value="form.overageRate as number | string" type="number" min="0" step="0.01" class="w-full" @update:model-value="set('overageRate', $event as number | string)" />
      </UFormField>
      <UFormField label="Unused hours" class="sm:col-span-2">
        <div class="space-y-3">
          <AppSelect
            :model-value="form.rolloverMode"
            :options="[{ label: 'Expire at the end of the period', value: 'expire' }, { label: 'Roll over to the next period', value: 'rollover' }]"
            @update:model-value="set('rolloverMode', ($event || 'expire') as 'expire' | 'rollover')"
          />
          <UFormField v-if="form.rolloverMode === 'rollover'" label="Rollover cap (hours)" hint="Leave blank for no cap">
            <UInput :model-value="form.limitHours as number | string" type="number" min="0" step="0.25" class="w-full" @update:model-value="set('limitHours', $event as number | string)" />
          </UFormField>
        </div>
      </UFormField>
      <div class="sm:col-span-2">
        <UCheckbox :model-value="form.autoPublish" label="Publish recurring invoices automatically" @update:model-value="set('autoPublish', Boolean($event))" />
        <p class="mt-1 text-xs text-dimmed">When this is off, each period invoice is created as a draft for you to review.</p>
      </div>
    </div>
  </div>
</template>
