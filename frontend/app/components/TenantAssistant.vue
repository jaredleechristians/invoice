<script setup lang="ts">
type ActionDetail = { label: string; value: string };
type AssistantAction = {
  id: string;
  tool: string;
  title: string;
  details: ActionDetail[];
  status: "pending" | "done" | "cancelled" | "failed" | "expired";
  result?: { kind: string; id: string; label: string; link: string };
  error?: string;
};
type Bubble =
  | { role: "user" | "assistant" | "error"; content: string }
  | { role: "action"; action: AssistantAction; busy?: "confirm" | "cancel" | "" };

const { user } = useAuth();
const { activeCompanyId, apiFetch } = useTenantApi();
const toast = useToast();
const dataVersion = useDataVersion();

const open = ref(false);
const sending = ref(false);
const draft = ref("");
const history = ref<{ role: "user" | "assistant"; content: string }[]>([]);
const bubbles = ref<Bubble[]>([]);
const DESCRIPTION =
  "Ask about your numbers or tell me what to add. I'll confirm before saving anything.";
const suggestions = ["Who owes us money?", "Add a fuel expense today", "Draft an invoice for a customer"];
const scroller = ref<HTMLElement | null>(null);

watch(
  () => bubbles.value.length,
  () => nextTick(() => scroller.value?.scrollTo({ top: scroller.value.scrollHeight, behavior: "smooth" }))
);
// A different company or user starts a fresh conversation.
watch([activeCompanyId, () => user.value?.uid], () => {
  bubbles.value = [];
  history.value = [];
});

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
    const data = await apiFetch<{ message: string; actions?: AssistantAction[] }>(
      `/companies/${activeCompanyId.value}/assistant`,
      { method: "POST", body: JSON.stringify({ messages: history.value }) }
    );
    const reply = data.message?.trim() || "No response.";
    bubbles.value.push({ role: "assistant", content: reply });
    for (const action of data.actions || []) bubbles.value.push({ role: "action", action, busy: "" });
    const proposed = (data.actions || []).map((a) => `[Proposed, awaiting the user's confirmation: ${a.title}]`).join("\n");
    history.value.push({ role: "assistant", content: proposed ? `${reply}\n${proposed}` : reply });
  } catch (e) {
    bubbles.value.push({ role: "error", content: e instanceof Error ? e.message : "Assistant failed" });
  } finally {
    sending.value = false;
  }
}

async function decide(b: Extract<Bubble, { role: "action" }>, verb: "confirm" | "cancel") {
  if (b.busy || b.action.status !== "pending") return;
  b.busy = verb;
  try {
    const data = await apiFetch<{ action: AssistantAction }>(
      `/companies/${activeCompanyId.value}/assistant/actions/${b.action.id}/${verb}`,
      { method: "POST", body: "{}" }
    );
    b.action = { ...b.action, ...data.action };
    // Let the model know what happened on its next turn.
    history.value.push({
      role: "user",
      content: verb === "confirm" ? `[I confirmed: ${b.action.title}. It was saved.]` : `[I cancelled: ${b.action.title}. Nothing was saved.]`,
    });
    if (verb === "confirm") {
      toast.add({ title: "Saved", description: b.action.title, color: "success", icon: "i-lucide-check" });
      dataVersion.value += 1;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed";
    b.action = { ...b.action, status: /already|expired/i.test(msg) ? b.action.status : "failed", error: msg };
    toast.add({ title: verb === "confirm" ? "Couldn't save" : "Couldn't cancel", description: msg, color: "error", icon: "i-lucide-circle-alert" });
  } finally {
    b.busy = "";
  }
}

const STATUS_BADGE: Record<AssistantAction["status"], { label: string; color: "neutral" | "success" | "error" | "warning" }> = {
  pending: { label: "Needs your OK", color: "warning" },
  done: { label: "Saved", color: "success" },
  cancelled: { label: "Cancelled", color: "neutral" },
  failed: { label: "Failed", color: "error" },
  expired: { label: "Expired", color: "neutral" },
};
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
          <p class="text-xs font-medium uppercase tracking-wide text-dimmed">Try</p>
          <div class="flex flex-wrap gap-2">
            <UButton v-for="s in suggestions" :key="s" size="xs" color="neutral" variant="outline" :label="s" @click="ask(s)" />
          </div>
        </div>

        <template v-for="(b, i) in bubbles" :key="i">
          <!-- Confirmation card: nothing is saved until Confirm. -->
          <div v-if="b.role === 'action'" class="rounded-lg border border-default bg-default shadow-xs" data-testid="assistant-action">
            <div class="flex items-start gap-2 px-3 pt-3">
              <UIcon name="i-lucide-clipboard-check" class="size-4 mt-0.5 text-primary shrink-0" />
              <p class="flex-1 font-medium text-highlighted">{{ b.action.title }}</p>
              <UBadge size="sm" variant="subtle" :color="STATUS_BADGE[b.action.status].color">{{ STATUS_BADGE[b.action.status].label }}</UBadge>
            </div>
            <dl v-if="b.action.details?.length" class="mx-3 mt-2 divide-y divide-default text-xs">
              <div v-for="(d, j) in b.action.details" :key="j" class="flex justify-between gap-3 py-1">
                <dt class="text-muted">{{ d.label }}</dt>
                <dd class="text-right tabular-nums text-default">{{ d.value }}</dd>
              </div>
            </dl>
            <p v-if="b.action.error" class="mx-3 mt-2 text-xs text-error">{{ b.action.error }}</p>
            <div class="flex items-center justify-end gap-2 p-3">
              <template v-if="b.action.status === 'pending'">
                <UButton size="xs" color="neutral" variant="ghost" :loading="b.busy === 'cancel'" :disabled="!!b.busy" @click="decide(b, 'cancel')">Cancel</UButton>
                <UButton size="xs" icon="i-lucide-check" :loading="b.busy === 'confirm'" :disabled="!!b.busy" @click="decide(b, 'confirm')">Confirm</UButton>
              </template>
              <UButton
                v-else-if="b.action.status === 'done' && b.action.result?.link"
                size="xs"
                variant="link"
                trailing-icon="i-lucide-arrow-right"
                :to="b.action.result.link"
                @click="open = false"
              >
                Open
              </UButton>
            </div>
          </div>

          <div v-else class="flex" :class="b.role === 'user' ? 'justify-end' : 'justify-start'">
            <div
              class="max-w-[85%] rounded-lg px-3 py-2"
              :style="b.role === 'assistant' ? undefined : 'white-space: pre-wrap'"
              :class="{
                'bg-primary text-inverted': b.role === 'user',
                'bg-elevated border border-default': b.role === 'assistant',
                'bg-error/10 text-error border border-error/20': b.role === 'error',
              }"
            >
              <ChatMarkdown v-if="b.role === 'assistant'" :text="b.content" />
              <template v-else>{{ b.content }}</template>
            </div>
          </div>
        </template>

        <div v-if="sending" class="flex items-center gap-2 text-dimmed">
          <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" /> Thinking…
        </div>
      </div>
    </template>

    <template #footer>
      <form class="flex w-full gap-2" @submit.prevent="sendMessage">
        <UInput v-model="draft" class="flex-1" placeholder="Ask a question or tell me what to add" :disabled="sending" autofocus />
        <UButton type="submit" icon="i-lucide-send" :loading="sending" :disabled="!draft.trim()" aria-label="Send" />
      </form>
    </template>
  </USlideover>
</template>
