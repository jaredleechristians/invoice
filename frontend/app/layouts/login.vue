<template>
  <div class="min-h-screen bg-default text-default flex flex-col">
    <header class="border-b border-default px-4 py-3 flex items-center justify-between">
      <NuxtLink to="/" class="flex items-center gap-2 font-semibold tracking-tight">
        <UIcon name="i-lucide-receipt-text" class="size-5 text-primary" />
        Invoice
      </NuxtLink>
      <UColorModeButton />
    </header>
    <main class="flex-1 flex items-center justify-center p-4">
      <slot />
    </main>
  </div>
</template>
