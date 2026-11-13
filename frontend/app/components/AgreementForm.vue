<script setup lang="ts">
import { CURRENCIES, formatCurrency } from "~/utils/money";
import { agreementValue, blankAgreementLine, agreementLineTotal, linesValue, type AgreementFormLine } from "~/utils/agreementValue";

type Customer = { id: string; name: string; currency?: string };
type Service = { id: string; name: string; unitPrice: number; currency?: string; kind: string };

const props = defineProps<{
  modelValue: {
    name: string;
    customerId: string;
    lines: AgreementFormLine[];
    startDate: string;
    endDate: string;
    period: "month" | "quarter";
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
const form = computed(() => props.modelValue);

const currencyOptions = computed(() => {
  const list = props.currencies?.length ? props.currencies : [...CURRENCIES];
  return list.map((c) => ({ label: c, value: c }));
});
const serviceOptions = computed(() => props.services.map((s) => ({ label: s.name, value: s.id })));

const { company } = useCompany();

const displayCurrency = computed(() =>
  form.value.currency || company.value?.baseCurrency || company.value?.defaultCurrency || "ZAR"
);

const periodTotal = computed(() => linesValue(form.value.lines));
const periodWord = computed(() => (form.value.period === "quarter" ? "Quarterly" : "Monthly"));

const valueSummary = computed(() =>
  agreementValue({
    lines: form.value.lines,
    startDate: form.value.startDate,
    endDate: form.value.endDate,
    period: form.value.period,
  })
);

function set<K extends keyof typeof props.modelValue>(key: K, value: (typeof props.modelValue)[K]) {
  emit("update:modelValue", { ...props.modelValue, [key]: value });
}

function setLines(lines: AgreementFormLine[]) {
  set("lines", lines);
}

function patchLine(index: number, patch: Partial<AgreementFormLine>) {
  const lines = props.modelValue.lines.map((l, i) => (i === index ? { ...l, ...patch } : l));
  setLines(lines);
}

function serviceById(id: string) {
  return props.services.find((s) => s.id === id);
}

/** Picking a service fills description and rate when they are blank or still the old service's defaults. */
function pickService(index: number, serviceId: string) {
  const line = props.modelValue.lines[index];
  if (!line) return;
  const prev = serviceById(line.serviceId);
  const next = serviceById(serviceId);
  const patch: Partial<AgreementFormLine> = { serviceId };
  if (next) {
    if (!line.description || (prev && line.description === prev.name)) patch.description = next.name;
    const rateBlank = line.rate === "" || line.rate == null;
    if (rateBlank || (prev && Number(line.rate) === Number(prev.unitPrice))) patch.rate = next.unitPrice ?? "";
  }
  patchLine(index, patch);
}

/** Only one line counts time entries. */
function setTracksTime(index: number, on: boolean) {
  setLines(props.modelValue.lines.map((l, i) => ({ ...l, tracksTime: i === index ? on : on ? false : l.tracksTime })));
}

function addLine() {
  setLines([...props.modelValue.lines, blankAgreementLine(!props.modelValue.lines.some((l) => l.tracksTime))]);
}

function removeLine(index: number) {
  const lines = props.modelValue.lines.filter((_, i) => i !== index);
  setLines(lines.length ? lines : [blankAgreementLine(true)]);
}

watch(
  () => [props.modelValue.customerId, props.modelValue.lines[0]?.serviceId],
  () => {
    const f = props.modelValue;
    const customer = props.customers.find((c) => c.id === f.customerId);
    const service = serviceById(f.lines[0]?.serviceId || "");
    const patch: Partial<typeof f> = {};
    if (!f.name && customer && service) patch.name = `${service.name} — ${customer.name}`;
    if (!f.currency && (customer?.currency || service?.currency)) patch.currency = customer?.currency || service?.currency || "";
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
      <UFormField label="Currency">
        <AppSelect :model-value="form.currency" :options="currencyOptions" @update:model-value="set('currency', String($event || ''))" />
      </UFormField>
      <UFormField label="Start date" required>
        <UInput :model-value="form.startDate" type="date" class="w-full" :disabled="locked" @update:model-value="set('startDate', String($event || ''))" />
      </UFormField>
      <UFormField>
        <template #label>End date <FieldHint text="Leave blank for an open-ended agreement" /></template>
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

      <div class="sm:col-span-2 space-y-3">
        <div class="flex items-baseline justify-between gap-3">
          <p class="text-sm font-medium">Agreement lines <FieldHint text="Each line is billed every period as qty × standard rate. The lines add up to the agreement value." /></p>
        </div>
        <div class="hidden sm:grid grid-cols-12 gap-2 px-1 text-xs uppercase tracking-wide text-dimmed">
          <span class="col-span-3">Billable service</span>
          <span class="col-span-3">Description</span>
          <span class="col-span-2 text-right">Qty</span>
          <span class="col-span-2 text-right">Standard rate</span>
          <span class="col-span-2 text-right">Line total</span>
        </div>
        <div v-for="(line, index) in form.lines" :key="line.key" class="rounded-lg border border-default p-3 space-y-3">
          <div class="grid grid-cols-2 sm:grid-cols-12 gap-2 items-center">
            <div class="col-span-2 sm:col-span-3">
              <AppSelect
                :model-value="line.serviceId"
                searchable
                placeholder="Select a service"
                :options="serviceOptions"
                @update:model-value="pickService(index, String($event || ''))"
              />
            </div>
            <UInput
              class="col-span-2 sm:col-span-3 w-full"
              placeholder="Description"
              :model-value="line.description"
              @update:model-value="patchLine(index, { description: String($event || '') })"
            />
            <UInput
              class="sm:col-span-2 w-full"
              type="number"
              min="0"
              step="any"
              placeholder="Qty"
              :ui="{ base: 'text-right' }"
              :model-value="String(line.qty ?? '')"
              @update:model-value="patchLine(index, { qty: $event as number | string })"
            />
            <UInput
              class="sm:col-span-2 w-full"
              type="number"
              min="0"
              step="0.01"
              placeholder="Standard rate"
              :ui="{ base: 'text-right' }"
              :model-value="String(line.rate ?? '')"
              @update:model-value="patchLine(index, { rate: $event as number | string })"
            />
            <div class="col-span-2 sm:col-span-2 flex items-center justify-end gap-1">
              <span class="tabular-nums text-sm">{{ formatCurrency(agreementLineTotal(line), displayCurrency) }}</span>
              <UButton
                icon="i-lucide-x"
                color="neutral"
                variant="ghost"
                size="xs"
                :aria-label="`Remove line ${index + 1}`"
                :disabled="form.lines.length === 1"
                @click="removeLine(index)"
              />
            </div>
          </div>
          <div class="flex flex-wrap items-start gap-x-6 gap-y-3">
            <div class="flex items-center gap-1">
              <UCheckbox
                :model-value="line.tracksTime"
                label="Time entries count against this line"
                @update:model-value="setTracksTime(index, Boolean($event))"
              />
              <FieldHint text="Time logged against this agreement uses this line's included qty; extra hours are billed as overage. Only one line can count time." />
            </div>
          </div>
          <div v-if="line.tracksTime" class="grid gap-3 sm:grid-cols-2">
            <UFormField>
              <template #label>Included qty <FieldHint :text="`Hours included per period before overage. Leave blank to use the line qty (${line.qty || 0}).`" /></template>
              <UInput
                :model-value="String(line.includedQty ?? '')"
                type="number"
                min="0"
                step="any"
                class="w-full"
                @update:model-value="patchLine(index, { includedQty: $event as number | string })"
              />
            </UFormField>
            <UFormField>
              <template #label>Overage rate <FieldHint text="Optional. Charged for hours beyond the included qty, on the next invoice. Falls back to the standard rate." /></template>
              <UInput
                :model-value="String(line.overageRate ?? '')"
                type="number"
                min="0"
                step="0.01"
                class="w-full"
                @update:model-value="patchLine(index, { overageRate: $event as number | string })"
              />
            </UFormField>
          </div>
        </div>
        <div class="flex items-center justify-between gap-3">
          <UButton icon="i-lucide-plus" color="neutral" variant="outline" size="sm" @click="addLine">Add line</UButton>
          <p class="text-sm">
            <span class="text-dimmed">{{ periodWord }} fee</span>
            <span class="ml-2 font-medium tabular-nums">{{ formatCurrency(periodTotal, displayCurrency) }}</span>
          </p>
        </div>
      </div>

      <div v-if="valueSummary" class="sm:col-span-2 rounded-lg border border-default px-4 py-3">
        <div class="flex items-baseline justify-between gap-3">
          <p class="text-sm font-medium">Agreement value <FieldHint text="Excludes overage. With an end date, the total prorates partial first and last periods; open-ended agreements show 12 months." /></p>
        </div>
        <dl class="mt-2 space-y-1 text-sm">
          <div class="flex justify-between gap-3">
            <dt class="text-dimmed">Monthly value</dt>
            <dd class="tabular-nums">{{ formatCurrency(valueSummary.monthlyValue, displayCurrency) }}</dd>
          </div>
          <div v-if="valueSummary.openEnded" class="flex justify-between gap-3">
            <dt class="text-dimmed">Annual value (open-ended)</dt>
            <dd class="tabular-nums">{{ formatCurrency(valueSummary.annualValue, displayCurrency) }}</dd>
          </div>
          <div v-else-if="valueSummary.totalValue != null" class="flex justify-between gap-3">
            <dt class="text-dimmed">Total agreement value</dt>
            <dd class="tabular-nums">{{ formatCurrency(valueSummary.totalValue, displayCurrency) }}</dd>
          </div>
        </dl>
      </div>
      <UFormField class="sm:col-span-2">
        <template #label>Unused hours <FieldHint text="Applies to the included qty on the line that time entries count against." /></template>
        <div class="space-y-3">
          <AppSelect
            :model-value="form.rolloverMode"
            :options="[{ label: 'Expire at the end of the period', value: 'expire' }, { label: 'Roll over to the next period', value: 'rollover' }]"
            @update:model-value="set('rolloverMode', ($event || 'expire') as 'expire' | 'rollover')"
          />
          <UFormField v-if="form.rolloverMode === 'rollover'">
            <template #label>Rollover cap (hours) <FieldHint text="Leave blank for no cap." /></template>
            <UInput :model-value="form.limitHours as number | string" type="number" min="0" step="0.25" class="w-full" @update:model-value="set('limitHours', $event as number | string)" />
          </UFormField>
        </div>
      </UFormField>
      <div class="sm:col-span-2">
        <div class="flex items-center gap-1">
          <UCheckbox :model-value="form.autoPublish" label="Publish recurring invoices automatically" @update:model-value="set('autoPublish', Boolean($event))" />
          <FieldHint text="When this is off, each period invoice is created as a draft for you to review." />
        </div>
      </div>
    </div>
  </div>
</template>
