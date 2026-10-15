<script setup lang="ts">
const { loadFromStorage, hydrated } = useInvoice()

onMounted(() => {
  loadFromStorage()
})
</script>

<template>
  <main class="page">
    <header class="landing-header">
      <p class="landing-header__hint">Create and download invoices without an account.</p>
      <a href="/dashboard/login" class="landing-sign-in">Sign in</a>
    </header>
    <InvoiceEditor v-if="hydrated" />
    <InvoiceChat v-if="hydrated" />
  </main>
</template>
