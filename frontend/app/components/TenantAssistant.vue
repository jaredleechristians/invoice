<script setup lang="ts">
type Bubble = { role: "user" | "assistant" | "system" | "error"; content: string };

const { user } = useAuth();
const { activeCompanyId, apiFetch } = useTenantApi();

const open = ref(false);
const sending = ref(false);
const draft = ref("");
const history = ref<{ role: "user" | "assistant"; content: string }[]>([]);
const bubbles = ref<Bubble[]>([]);
const DESCRIPTION =
  "Ask about customers, invoices, who owes money, or a customer statement. I use live company data (read-only).";
const suggestions = ["Who owes us money?", "Which invoices are overdue?", "Income this month"];
const scroller = ref<HTMLElement | null>(null);

watch(
  () => bubbles.value.length,
  () => nextTick(() => scroller.value?.scrollTo({ top: scroller.value.scrollHeight, behavior: "smooth" }))
);

function ask(text: string) {
  draft.value = text;
  sendMessage();
}

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
  <USlideover
    v-if="user && activeCompanyId"
    v-model:open="open"
    title="Company assistant"
    :description="DESCRIPTION"
    :ui="{ content: 'sm:max-w-md', body: 'p-0 sm:p-0' }"
  >
    <UButton icon="i-lucide-sparkles" variant="soft" color="primary" label="Assistant" />

    <template #body>
      <div ref="scroller" class="h-full overflow-y-auto p-4 space-y-3 text-sm">
        <div v-if="!bubbles.length" class="space-y-2">
          <p class="text-xs font-medium uppercase tracking-wide text-dimmed">Try asking</p>
          <div class="flex flex-wrap gap-2">
            <UButton
              v-for="s in suggestions"
              :key="s"
              size="xs"
              color="neutral"
              variant="outline"
              :label="s"
              @click="ask(s)"
            />
          </div>
        </div>
        <div
          v-for="(b, i) in bubbles"
          :key="i"
          class="flex"
          :class="b.role === 'user' ? 'justify-end' : 'justify-start'"
        >
          <div
            class="max-w-[85%] rounded-lg px-3 py-2 whitespace-pre-wrap"
            :class="{
              'bg-primary text-inverted': b.role === 'user',
              'bg-elevated border border-default': b.role === 'assistant',
              'bg-error/10 text-error border border-error/20': b.role === 'error',
            }"
          >
            {{ b.content }}
          </div>
        </div>
        <div v-if="sending" class="flex items-center gap-2 text-dimmed">
          <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" /> Thinking…
        </div>
      </div>
    </template>

    <template #footer>
      <form class="flex w-full gap-2" @submit.prevent="sendMessage">
        <UInput v-model="draft" class="flex-1" placeholder="Who owes us money?" :disabled="sending" autofocus />
        <UButton type="submit" icon="i-lucide-send" :loading="sending" :disabled="!draft.trim()" aria-label="Send" />
      </form>
    </template>
  </USlideover>
</template>
