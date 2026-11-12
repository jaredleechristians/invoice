<script setup lang="ts">
import { addDays, formatCurrency, todayIso } from "~/utils/money";

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
  exchangeRate?: number | null;
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
const baseCurrency = computed(() => company.value?.baseCurrency || "ZAR");
const isForeign = computed(() => isInvoice.value && form.currency !== baseCurrency.value);
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
  exchangeRate: "" as string | number,
});

const vatRate = computed(() =>
  props.initial?.vatRate !== undefined && props.initial !== null
    ? Number(props.initial.vatRate) || 0
    : company.value?.vatRegistered
      ? Number(company.value.vatRate) || 0
      : 0
);

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
  form.exchangeRate = src?.exchangeRate ? Number(src.exchangeRate) : "";
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
  if (isInvoice.value) {
    body.dueDate = form.dueDate;
    if (isForeign.value) body.exchangeRate = Number(form.exchangeRate) > 0 ? Number(form.exchangeRate) : null;
    else body.exchangeRate = null;
  }
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
        <UFormField v-if="isForeign" :label="`${baseCurrency} per ${form.currency} on issue date`" hint="Required to publish" help="The rate on the issue date, in the company base currency. Needed before a foreign invoice can be published.">
          <UInput v-model="form.exchangeRate" type="number" step="0.0001" min="0" placeholder="e.g. 18.25" class="w-full" required />
        </UFormField>
      </div>
    </UCard>

    <LineItemsEditor v-model="form.items" :currency="form.currency" :vat-rate="vatRate" :new-line="blankLine">
      <template #line-extra="{ line }">
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
      </template>
    </LineItemsEditor>

    <UCard>
      <UFormField label="Notes (shown on the document)">
        <UTextarea v-model="form.notes" :rows="3" class="w-full" />
      </UFormField>
    </UCard>

    <div class="flex flex-wrap gap-2">
      <template v-if="isInvoice">
        <UButton type="submit" :loading="saving" variant="soft">{{ isDraft ? "Save draft" : "Save changes" }}</UButton>
        <UButton v-if="isDraft && isInvoice" :loading="saving" icon="i-lucide-check" @click="submit(true)">Publish</UButton>
      </template>
      <UButton v-else type="submit" :loading="saving">Save quote</UButton>
    </div>
  </form>
</template>
