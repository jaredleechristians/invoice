<script setup lang="ts">
/**
 * Declares the page's navbar title override and info tooltip (shown in the
 * dashboard top bar) and renders the page toolbar in place: filters on the
 * left (#filters slot), page actions right-aligned (default slot). The page
 * title lives only in the top bar, never repeated in the page.
 */
const props = defineProps<{ title?: string; info?: string }>();
const header = usePageHeader();
const owner = Math.random();

watchEffect(() => {
  header.value = { title: props.title || "", info: props.info || "", owner };
});
onBeforeUnmount(() => {
  // Only clear if a newer page hasn't already claimed the header.
  if (header.value?.owner === owner) header.value = { title: "", info: "", owner: 0 };
});
</script>

<template>
  <div v-if="$slots.default || $slots.filters" class="flex flex-wrap items-center gap-2">
    <div class="flex min-w-0 flex-1 flex-wrap items-center gap-2">
      <slot name="filters" />
    </div>
    <div v-if="$slots.default" class="flex flex-wrap items-center justify-end gap-2">
      <slot />
    </div>
  </div>
</template>
