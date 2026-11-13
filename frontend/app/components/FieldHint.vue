<script setup lang="ts">
/**
 * Info icon with the field's description in a tooltip (hover or keyboard focus).
 * Use next to a label instead of inline hint text, e.g. in a UFormField #label slot:
 *   <UFormField><template #label>End date <FieldHint text="Leave blank for an open-ended agreement" /></template>…</UFormField>
 */
defineProps<{ text: string; side?: "top" | "right" | "bottom" | "left" }>();
</script>

<template>
  <UTooltip
    :text="text"
    :content="{ side: side || 'top', align: 'start' }"
    :ui="{ content: 'max-w-xs h-auto py-1.5', text: 'whitespace-normal' }"
  >
    <UButton
      icon="i-lucide-info"
      color="neutral"
      variant="link"
      size="xs"
      class="align-middle text-dimmed hover:text-muted focus-visible:text-muted p-0.5"
      :aria-label="text"
    />
  </UTooltip>
</template>
