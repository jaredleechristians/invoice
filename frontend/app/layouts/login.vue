<template>
  <div class="relative min-h-dvh flex items-center justify-center px-4 py-12 bg-muted text-default overflow-hidden">
    <div
      aria-hidden="true"
      class="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_70%_50%_at_50%_-10%,var(--ui-color-primary-500)_0%,transparent_70%)] opacity-15 dark:opacity-25"
    />
    <UColorModeButton class="absolute top-4 right-4" />
    <main class="relative w-full flex justify-center">
      <slot />
    </main>
  </div>
</template>
