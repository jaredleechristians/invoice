<script setup lang="ts">
/**
 * Declares the page's navbar title override, info tooltip and action buttons.
 * Renders nothing in place: actions (default slot) are teleported into the
 * dashboard navbar, so the page title is only shown once.
 */
const props = defineProps<{ title?: string; info?: string }>();
const header = usePageHeader();
const owner = Math.random();

watchEffect(() => {
  header.value = { title: props.title || "", info: props.info || "", owner };
});
onBeforeUnmount(() => {
  // Only clear if a newer page hasn't already claimed the header.
  if (header.value.owner === owner) header.value = { title: "", info: "", owner: 0 };
});
</script>

<template>
  <Teleport v-if="$slots.default" defer to="#dashboard-navbar-actions">
    <slot />
  </Teleport>
</template>
