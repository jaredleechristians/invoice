<script setup lang="ts">
const { loadFromStorage, hydrated } = useInvoice()

onMounted(() => {
  loadFromStorage()
})
</script>

<template>
  <main class="page">
    <InvoiceEditor v-if="hydrated" />
    <InvoiceChat v-if="hydrated" />
  </main>
</template>
