<template>
  <div class="min-h-screen bg-neutral-950 text-neutral-100 flex flex-col">
    <header class="border-b border-neutral-800 px-4 py-3">
      <NuxtLink to="/" class="font-semibold tracking-tight">Invoice</NuxtLink>
    </header>
    <main class="flex-1 flex items-center justify-center p-4">
      <slot />
    </main>
  </div>
</template>
