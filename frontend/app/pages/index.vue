<script setup lang="ts">
const { invoice, loadFromStorage, hydrated, saveToStorage, savedFlash } = useInvoice()
const { downloadPdf, pdfBusy } = useInvoicePdf()

onMounted(() => {
  loadFromStorage()
})
</script>

<template>
  <div class="min-h-screen bg-default">
    <!-- Top bar mirrors the dashboard navbar: title on the left, Assistant on the right. -->
    <header class="sticky top-0 z-40 border-b border-default bg-default/85 backdrop-blur print:hidden">
      <div class="flex h-(--ui-header-height) items-center gap-2 px-4 sm:px-6">
        <NuxtLink to="/" class="flex items-center gap-2 shrink-0" aria-label="Invoice">
          <span class="grid size-8 place-items-center rounded-lg bg-primary/10 ring-1 ring-primary/20">
            <UIcon name="i-lucide-receipt-text" class="size-4.5 text-primary" />
          </span>
          <span class="font-semibold text-highlighted hidden sm:inline">Invoice</span>
        </NuxtLink>
        <USeparator orientation="vertical" class="h-6 mx-1" />
        <h1 class="min-w-0 truncate font-semibold text-highlighted">
          {{ hydrated && invoice.invoiceNumber ? invoice.invoiceNumber : "New invoice" }}
        </h1>
        <UBadge color="neutral" variant="subtle" size="sm" class="hidden md:inline-flex">No account needed</UBadge>

        <div class="ms-auto flex items-center gap-1.5">
          <InvoiceChat v-if="hydrated" />
          <UColorModeButton />
          <UButton to="/dashboard/login" color="neutral" variant="outline" icon="i-lucide-log-in" label="Sign in" class="max-sm:[&>span:last-child]:hidden" />
        </div>
      </div>
    </header>

    <!-- Same container, toolbar and cards as the signed-in invoice page. -->
    <main class="p-4 sm:p-6 print:hidden">
      <div class="mx-auto w-full max-w-5xl space-y-6">
        <PageHeader title="New invoice">
          <template #filters>
            <p class="text-sm text-muted">
              Saved in this browser only —
              <ULink to="/dashboard/login" class="text-primary font-medium">sign in</ULink> to keep invoices, customers and payments.
            </p>
          </template>
          <UButton
            variant="soft"
            :icon="savedFlash ? 'i-lucide-check' : 'i-lucide-save'"
            :label="savedFlash ? 'Saved' : 'Save'"
            aria-label="Save in this browser"
            @click="saveToStorage"
          />
          <UButton icon="i-lucide-file-down" label="Download PDF" :loading="pdfBusy" aria-label="Download PDF" @click="downloadPdf" />
        </PageHeader>
        <InvoiceEditor v-if="hydrated" />
      </div>
    </main>

    <!-- Browser print keeps the original A4 invoice sheet. -->
    <main class="page hidden print:block" aria-hidden="true">
      <InvoiceSheet v-if="hydrated" />
    </main>
  </div>
</template>
