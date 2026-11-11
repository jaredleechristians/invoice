<script setup lang="ts">
// Assistant reply as safe markdown (see utils/markdown.ts: input is escaped, only a few tags are emitted).
import { renderMarkdown } from "~/utils/markdown";

const props = defineProps<{ text: string }>();
const html = computed(() => renderMarkdown(props.text));
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -->
  <div class="chat-md" v-html="html" />
</template>

<style scoped>
.chat-md :deep(p) { margin: 0; }
.chat-md :deep(p + p),
.chat-md :deep(p + ul),
.chat-md :deep(p + ol),
.chat-md :deep(ul + p),
.chat-md :deep(ol + p) { margin-top: 0.5rem; }
.chat-md :deep(ul) { list-style: disc; padding-left: 1.25rem; }
.chat-md :deep(ol) { list-style: decimal; padding-left: 1.25rem; }
.chat-md :deep(li + li) { margin-top: 0.125rem; }
.chat-md :deep(strong) { font-weight: 600; color: var(--ui-text-highlighted); }
.chat-md :deep(code) { font-family: ui-monospace, monospace; font-size: 0.85em; padding: 0 0.25rem; border-radius: 0.25rem; background: var(--ui-bg-accented); }
.chat-md :deep(a) { color: var(--ui-primary); text-decoration: underline; text-underline-offset: 2px; }
</style>
