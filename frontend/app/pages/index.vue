<script setup lang="ts">
const { loadFromStorage, hydrated, saveToStorage, savedFlash } = useInvoice()
const { downloadPdf, pdfBusy } = useInvoicePdf()

onMounted(() => {
  loadFromStorage()
})
</script>

<template>
  <div class="min-h-screen bg-muted/60 dark:bg-default">
    <header class="sticky top-0 z-40 border-b border-default bg-default/85 backdrop-blur print:hidden">
      <div class="mx-auto flex h-14 max-w-[calc(210mm+2rem)] items-center gap-2 px-4">
        <NuxtLink to="/" class="flex items-center gap-2 shrink-0" aria-label="Invoice">
          <span class="grid size-8 place-items-center rounded-lg bg-primary/10 ring-1 ring-primary/20">
            <UIcon name="i-lucide-receipt-text" class="size-4.5 text-primary" />
          </span>
          <span class="font-semibold text-highlighted">Invoice</span>
        </NuxtLink>
        <UBadge color="neutral" variant="subtle" size="sm" class="hidden md:inline-flex">No account needed</UBadge>

        <div class="ms-auto flex items-center gap-1.5">
          <InvoiceChat v-if="hydrated" />
          <UButton
            color="neutral"
            variant="ghost"
            :icon="savedFlash ? 'i-lucide-check' : 'i-lucide-save'"
            :label="savedFlash ? 'Saved' : 'Save'"
            class="max-sm:[&>span:last-child]:hidden"
            aria-label="Save in this browser"
            @click="saveToStorage"
          />
          <UButton
            icon="i-lucide-file-down"
            label="Download PDF"
            :loading="pdfBusy"
            class="max-sm:[&>span:last-child]:hidden"
            aria-label="Download PDF"
            @click="downloadPdf"
          />
          <UColorModeButton />
          <USeparator orientation="vertical" class="h-6 mx-1 hidden sm:block" />
          <UButton to="/dashboard/login" color="neutral" variant="outline" icon="i-lucide-log-in" label="Sign in" class="max-sm:[&>span:last-child]:hidden" />
        </div>
      </div>
    </header>

    <main class="page">
      <p class="mx-auto mb-4 max-w-[210mm] text-sm text-muted print:hidden">
        Edit the invoice right on the page. It's saved in this browser only —
        <ULink to="/dashboard/login" class="text-primary font-medium">sign in</ULink> to keep invoices, customers and payments for your company.
      </p>
      <InvoiceEditor v-if="hydrated" />
    </main>
  </div>
</template>
