<script setup lang="ts">
import { addDays, docTotals, formatCurrency, lineTotal, todayIso } from "~/utils/money";

type Line = { productId?: string; description: string; note: string; qty: number; unitPrice: number; taxable: boolean };
type Customer = { id: string; name: string; currency?: string; email?: string };
// @products-start
type Product = { id: string; name: string; description?: string; unitPrice: number; currency?: string; taxable?: boolean };
// @products-end

type DocumentInput = {
  customerId?: string;
  customerName?: string;
  currency?: string;
  issueDate?: string;
  dueDate?: string;
  expiryDate?: string;
  reference?: string;
  notes?: string;
  items?: Line[];
  vatRate?: number;
  draft?: boolean;
  invoiceNumber?: string;
  quoteNumber?: string;
  paidAmount?: number;
};

const props = withDefaults(
  defineProps<{ kind?: "invoice" | "quote"; initial?: DocumentInput | null; saving?: boolean }>(),
  { kind: "invoice", initial: null, saving: false }
);
const emit = defineEmits<{ submit: [payload: { body: Record<string, unknown>; finalize: boolean }] }>();

const route = useRoute();
const { capi, cpost } = useCompanyApi();
const { company, ensure, currencies } = useCompany();

const customers = ref<Customer[]>([]);
// @products-start
const products = ref<Product[]>([]);
// @products-end
const error = ref("");
const newCustomer = reactive({ open: false, name: "", email: "", saving: false });

const isInvoice = computed(() => props.kind === "invoice");
const isDraft = computed(() => !props.initial || props.initial.draft !== false);
const locked = computed(() => Boolean(props.initial && props.initial.paidAmount && props.initial.paidAmount > 0));

const form = reactive({
  customerId: "",
  customerName: "",
  currency: "ZAR",
  issueDate: todayIso(),
  dueDate: "",
  expiryDate: "",
  reference: "",
  notes: "",
  items: [] as Line[],
});

const vatRate = computed(() =>
  props.initial?.vatRate !== undefined && props.initial !== null
    ? Number(props.initial.vatRate) || 0
    : company.value?.vatRegistered
      ? Number(company.value.vatRate) || 0
      : 0
);
const totals = computed(() => docTotals(form.items, vatRate.value));

function blankLine(): Line {
  return { productId: "", description: "", note: "", qty: 1, unitPrice: 0, taxable: true };
}

function termsDays() {
  return isInvoice.value ? company.value?.paymentTermsDays ?? 30 : company.value?.quoteValidDays ?? 30;
}

async function init() {
  error.value = "";
  try {
    await ensure();
    const [c] = await Promise.all([
      capi<{ customers: Customer[] }>("/customers"),
      // @products-start
      capi<{ products: Product[] }>("/products").then((p) => (products.value = p.products)).catch(() => {}),
      // @products-end
    ]);
    customers.value = c.customers;
  } catch (e) {
    error.value = errMsg(e);
  }
  const src = props.initial;
  const preset = typeof route.query.customer === "string" ? route.query.customer : "";
  form.customerId = src?.customerId || (customers.value.some((c) => c.id === preset) ? preset : "");
  form.customerName = src?.customerId ? "" : src?.customerName || "";
  form.currency =
    src?.currency || customers.value.find((c) => c.id === form.customerId)?.currency || company.value?.defaultCurrency || "ZAR";
  form.issueDate = src?.issueDate && /^\d{4}-\d{2}-\d{2}/.test(src.issueDate) ? src.issueDate.slice(0, 10) : todayIso();
  form.dueDate = src?.dueDate && /^\d{4}-\d{2}-\d{2}/.test(src.dueDate) ? src.dueDate.slice(0, 10) : addDays(form.issueDate, termsDays());
  form.expiryDate = src?.expiryDate ? src.expiryDate.slice(0, 10) : addDays(form.issueDate, termsDays());
  form.reference = src?.reference || "";
  form.notes = src ? src.notes || "" : isInvoice.value ? company.value?.defaultNotes || "" : "";
  form.items = src?.items?.length
    ? src.items.map((i) => ({ ...blankLine(), ...i, qty: Number(i.qty) || 0, unitPrice: Number(i.unitPrice) || 0, taxable: i.taxable !== false }))
    : [blankLine()];
}

onMounted(init);

watch(() => form.customerId, (id, old) => {
  if (!id || id === old || props.initial) return;
  const c = customers.value.find((x) => x.id === id);
  if (c?.currency) form.currency = c.currency;
});

// Quick due/expiry dates relative to the issue date.
const termPresets = computed(() =>
  form.issueDate
    ? [
        { label: "On issue date", value: form.issueDate },
        ...[7, 14, 30, 60].map((d) => ({ label: `${d} days`, value: addDays(form.issueDate, d) })),
      ]
    : []
);

function onIssueDateChange() {
  if (isInvoice.value) form.dueDate = addDays(form.issueDate, termsDays());
  else form.expiryDate = addDays(form.issueDate, termsDays());
}

async function addCustomer() {
  if (!newCustomer.name.trim()) return;
  newCustomer.saving = true;
  try {
    const c = await cpost<Customer>("/customers", { name: newCustomer.name, email: newCustomer.email, currency: form.currency });
    customers.value = [...customers.value, c].sort((a, b) => a.name.localeCompare(b.name));
    form.customerId = c.id;
    Object.assign(newCustomer, { open: false, name: "", email: "" });
  } catch (e) {
    error.value = errMsg(e);
  } finally {
    newCustomer.saving = false;
  }
}

// @products-start
function applyProduct(line: Line, productId: string) {
  line.productId = productId;
  const p = products.value.find((x) => x.id === productId);
  if (!p) return;
  line.description = p.name;
  line.note = p.description || "";
  line.unitPrice = Number(p.unitPrice) || 0;
  line.taxable = p.taxable !== false;
}
const productOptions = computed(() =>
  products.value.map((p) => ({
    label: `${p.name}${p.currency ? ` · ${formatCurrency(p.unitPrice, p.currency)}` : ""}`,
    value: p.id,
  }))
);
// @products-end

// Line fields show their own label on mobile; desktop uses the header row.
const LINE_FIELD_UI = { labelWrapper: "sm:hidden" };

function move(i: number, dir: -1 | 1) {
  const j = i + dir;
  if (j < 0 || j >= form.items.length) return;
  const [row] = form.items.splice(i, 1);
  form.items.splice(j, 0, row!);
}

function submit(finalize: boolean) {
  const body: Record<string, unknown> = {
    customerId: form.customerId,
    currency: form.currency,
    issueDate: form.issueDate,
    reference: form.reference,
    notes: form.notes,
    items: form.items
      .filter((i) => i.description.trim() || Number(i.unitPrice))
      .map((i) => ({ ...i, qty: Number(i.qty) || 0, unitPrice: Number(i.unitPrice) || 0 })),
  };
  if (!form.customerId) body.customerName = form.customerName;
  if (isInvoice.value) body.dueDate = form.dueDate;
  else body.expiryDate = form.expiryDate;
  emit("submit", { body, finalize });
}
</script>

<template>
  <form class="space-y-6" @submit.prevent="submit(false)">
    <UAlert v-if="error" color="error" variant="subtle" :title="error" />

    <UCard>
      <div class="grid gap-4 sm:grid-cols-4">
        <UFormField label="Customer" class="sm:col-span-2">
          <div class="flex gap-2">
            <AppSelect
              v-model="form.customerId"
              placeholder="— Select customer —"
              searchable
              icon="i-lucide-user"
              :options="customers.map((c) => ({ label: c.name, value: c.id, description: c.email || undefined }))"
            />
            <UButton size="sm" variant="soft" icon="i-lucide-user-plus" @click="newCustomer.open = !newCustomer.open" />
          </div>
          <UInput
            v-if="!form.customerId && initial?.customerName"
            v-model="form.customerName"
            class="w-full mt-2"
            placeholder="Customer name (no linked customer)"
          />
        </UFormField>
        <UFormField label="Currency">
          <AppSelect v-model="form.currency" searchable :disabled="locked" :options="currencies.map((c) => ({ label: c, value: c }))" />
        </UFormField>
        <UFormField label="Reference / PO">
          <UInput v-model="form.reference" class="w-full" />
        </UFormField>

        <div v-if="newCustomer.open" class="sm:col-span-4 flex flex-wrap gap-2 items-end border border-default rounded-lg p-3">
          <UFormField label="New customer name" class="flex-1 min-w-48"><UInput v-model="newCustomer.name" class="w-full" /></UFormField>
          <UFormField label="Email" class="flex-1 min-w-48"><UInput v-model="newCustomer.email" type="email" class="w-full" /></UFormField>
          <UButton :loading="newCustomer.saving" @click="addCustomer">Add customer</UButton>
        </div>

        <UFormField :label="isInvoice ? 'Issue date' : 'Quote date'">
          <DatePicker v-model="form.issueDate" block @change="onIssueDateChange" />
        </UFormField>
        <UFormField v-if="isInvoice" label="Due date">
          <DatePicker v-model="form.dueDate" block :presets="termPresets" />
        </UFormField>
        <UFormField v-else label="Valid until">
          <DatePicker v-model="form.expiryDate" block :presets="termPresets" />
        </UFormField>
      </div>
    </UCard>

    <UCard>
      <template #header><span class="font-medium">Line items</span></template>
      <div class="space-y-3">
        <!-- Column headers (desktop). On mobile every field carries its own label. -->
        <div
          class="hidden sm:grid grid-cols-[minmax(0,1fr)_5.5rem_8.5rem_8.5rem_5.5rem] gap-3 border-b border-default pb-2 text-xs font-medium uppercase tracking-wide text-dimmed"
        >
          <span>Item / description</span>
          <span class="text-right">Qty</span>
          <span class="text-right">Price ({{ form.currency }})</span>
          <span class="text-right">Amount</span>
          <span class="sr-only">Actions</span>
        </div>

        <div
          v-for="(line, i) in form.items"
          :key="i"
          class="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-[minmax(0,1fr)_5.5rem_8.5rem_8.5rem_5.5rem] items-start border-b border-default pb-3 last:border-b-0"
        >
          <UFormField label="Item / description" class="col-span-2 sm:col-span-1" :ui="LINE_FIELD_UI">
            <div class="space-y-2">
              <UInput v-model="line.description" placeholder="Description" aria-label="Description" class="w-full" />
              <UTextarea v-model="line.note" :rows="1" autoresize placeholder="Details (optional)" aria-label="Details" class="w-full" />
              <div v-if="products.length || vatRate > 0" class="flex flex-wrap items-center gap-3">
                <!-- @products-start -->
                <div v-if="products.length" class="min-w-0 flex-1 sm:max-w-xs">
                  <AppSelect
                    :model-value="line.productId || ''"
                    placeholder="Fill from a product (optional)"
                    searchable
                    size="sm"
                    icon="i-lucide-package"
                    :options="productOptions"
                    @update:model-value="applyProduct(line, String($event))"
                  />
                </div>
                <!-- @products-end -->
                <UCheckbox v-if="vatRate > 0" v-model="line.taxable" :label="`VAT ${vatRate}%`" />
              </div>
            </div>
          </UFormField>
          <UFormField label="Qty" :ui="LINE_FIELD_UI">
            <UInput v-model.number="line.qty" type="number" step="any" aria-label="Quantity" class="w-full" :ui="{ base: 'text-right tabular-nums' }" />
          </UFormField>
          <UFormField :label="`Price (${form.currency})`" :ui="LINE_FIELD_UI">
            <UInput v-model.number="line.unitPrice" type="number" step="0.01" aria-label="Unit price" class="w-full" :ui="{ base: 'text-right tabular-nums' }" />
          </UFormField>
          <UFormField label="Amount" :ui="LINE_FIELD_UI">
            <p class="flex h-8 items-center justify-end tabular-nums font-medium">{{ formatCurrency(lineTotal(line), form.currency) }}</p>
          </UFormField>
          <div class="flex h-8 items-center justify-end gap-0.5 self-end sm:self-start">
            <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-arrow-up" aria-label="Move up" :disabled="i === 0" @click="move(i, -1)" />
            <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-arrow-down" aria-label="Move down" :disabled="i === form.items.length - 1" @click="move(i, 1)" />
            <UButton size="xs" variant="ghost" color="error" icon="i-lucide-trash" aria-label="Remove line" @click="form.items.splice(i, 1)" />
          </div>
        </div>
        <UButton size="sm" variant="soft" icon="i-lucide-plus" @click="form.items.push(blankLine())">Add line</UButton>
      </div>

      <div class="flex justify-end mt-6">
        <div class="w-72 space-y-1 text-sm">
          <div v-if="vatRate > 0" class="flex justify-between"><span>Subtotal</span><span class="tabular-nums">{{ formatCurrency(totals.subtotal, form.currency) }}</span></div>
          <div v-if="vatRate > 0" class="flex justify-between"><span>VAT ({{ vatRate }}%)</span><span class="tabular-nums">{{ formatCurrency(totals.taxTotal, form.currency) }}</span></div>
          <div class="flex justify-between text-lg font-semibold border-t border-accented pt-2"><span>Total</span><span class="tabular-nums">{{ formatCurrency(totals.total, form.currency) }}</span></div>
        </div>
      </div>
    </UCard>

    <UCard>
      <UFormField label="Notes (shown on the document)">
        <UTextarea v-model="form.notes" :rows="3" class="w-full" />
      </UFormField>
    </UCard>

    <div class="flex flex-wrap gap-2">
      <template v-if="isInvoice">
        <UButton type="submit" :loading="saving" variant="soft">{{ isDraft ? "Save draft" : "Save changes" }}</UButton>
        <UButton v-if="isDraft" :loading="saving" icon="i-lucide-check" @click="submit(true)">Save &amp; finalize</UButton>
      </template>
      <UButton v-else type="submit" :loading="saving">Save quote</UButton>
    </div>
  </form>
</template>
