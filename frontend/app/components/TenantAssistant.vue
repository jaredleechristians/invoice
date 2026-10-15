<script setup lang="ts">
type Bubble = { role: "user" | "assistant" | "system" | "error"; content: string };

const { user } = useAuth();
const { activeCompanyId, apiFetch } = useTenantApi();

const open = ref(false);
const sending = ref(false);
const draft = ref("");
const history = ref<{ role: "user" | "assistant"; content: string }[]>([]);
const bubbles = ref<Bubble[]>([
  {
    role: "system",
    content:
      "Ask about customers, invoices, who owes money, or a customer statement. I use live company data (read-only).",
  },
]);

async function sendMessage() {
  const text = draft.value.trim();
  if (!text || sending.value || !activeCompanyId.value || !user.value) return;

  draft.value = "";
  bubbles.value.push({ role: "user", content: text });
  history.value.push({ role: "user", content: text });
  sending.value = true;

  try {
    const data = await apiFetch<{ message: string }>(
      `/companies/${activeCompanyId.value}/assistant`,
      {
        method: "POST",
        body: JSON.stringify({ messages: history.value }),
      }
    );
    const reply = data.message?.trim() || "No response.";
    bubbles.value.push({ role: "assistant", content: reply });
    history.value.push({ role: "assistant", content: reply });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Assistant failed";
    bubbles.value.push({ role: "error", content: msg });
  } finally {
    sending.value = false;
  }
}
</script>

<template>
  <div>
    <UButton
      v-if="user && activeCompanyId"
      icon="i-lucide-sparkles"
      variant="soft"
      color="primary"
      @click="open = true"
    >
      Assistant
    </UButton>
    <USlideover v-model:open="open" title="Company assistant" :ui="{ width: 'sm:max-w-md' }">
      <div class="flex flex-col h-full gap-3 p-4">
        <div class="flex-1 overflow-y-auto space-y-2 text-sm">
          <div
            v-for="(b, i) in bubbles"
            :key="i"
            class="rounded-lg px-3 py-2"
            :class="{
              'bg-neutral-800': b.role === 'user',
              'bg-neutral-900 border border-neutral-800': b.role === 'assistant',
              'text-neutral-500': b.role === 'system',
              'text-red-400': b.role === 'error',
            }"
          >
            {{ b.content }}
          </div>
        </div>
        <form class="flex gap-2" @submit.prevent="sendMessage">
          <UInput
            v-model="draft"
            class="flex-1"
            placeholder="Who owes us money?"
            :disabled="sending"
          />
          <UButton type="submit" :loading="sending">Send</UButton>
        </form>
      </div>
    </USlideover>
  </div>
</template>
