<script setup lang="ts">
type ChatBubble = {
  role: 'user' | 'assistant' | 'system' | 'error'
  content: string
}

const { invoice, applyInvoice } = useInvoice()

const open = ref(false)
const sending = ref(false)
const draft = ref('')
const messagesEl = ref<HTMLElement | null>(null)
const history = ref<{ role: 'user' | 'assistant'; content: string }[]>([])
const bubbles = ref<ChatBubble[]>([])

const suggestions = [
  "Bill Acme Pty Ltd, Cape Town, 10 hours design at R850",
  "Make it due in 30 days",
  "Add a line: hosting, 12 months at R150",
]

function ask(text: string) {
  draft.value = text
  sendMessage()
}

watch(open, async (value) => {
  if (value) {
    await nextTick()
    scrollToBottom()
  }
})

function scrollToBottom() {
  const el = messagesEl.value
  if (!el) return
  el.scrollTop = el.scrollHeight
}

async function sendMessage() {
  const text = draft.value.trim()
  if (!text || sending.value) return

  draft.value = ''
  bubbles.value.push({ role: 'user', content: text })
  history.value.push({ role: 'user', content: text })
  sending.value = true
  await nextTick()
  scrollToBottom()

  try {
    const sentInvoice = cloneInvoice(invoice.value)

    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: history.value,
        invoice: sentInvoice,
      }),
    })

    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new Error(
        data?.error ||
          data?.message ||
          data?.detail ||
          data?.statusMessage ||
          `HTTP ${res.status}`,
      )
    }

    let message = typeof data.message === 'string' ? data.message.trim() : ''
    let nextInvoice = data.invoice && typeof data.invoice === 'object' ? data.invoice : null

    if (!message || !nextInvoice) {
      const parsed = parseAssistantPayload(String(data.content || ''))
      if (!message) message = parsed.message
      if (!nextInvoice) nextInvoice = parsed.invoice
    }

    if (/^(done\.?|ok\.?|updated\.?)$/i.test(message) && nextInvoice) {
      message = 'Invoice updated.'
    }

    const effective = nextInvoice ? diffInvoicePatch(nextInvoice, sentInvoice) : null
    let applied = false
    if (nextInvoice) {
      applied = applyInvoice(nextInvoice, sentInvoice)
    }

    let reply = message
    if (applied && !reply) reply = 'Invoice updated.'
    if (!applied && nextInvoice) {
      reply = reply || 'No field changes detected in the assistant response.'
    }
    if (!applied && !nextInvoice) {
      reply =
        reply && !/^(done\.?|ok\.?)$/i.test(reply)
          ? reply
          : 'No invoice update was returned. Please try again or rephrase.'
    }

    if (applied && effective) {
      const summary = describeInvoicePatch(effective)
      const next = suggestNextInvoiceStep(effective)
      const feedback = [
        summary ? `Applied: ${summary}.` : 'Applied your changes.',
        next
          ? `Still useful to add: ${next.hint.toLowerCase()}.`
          : 'Looks complete — tweak anything else if needed.',
      ].join('\n')
      reply = reply ? `${reply}\n\n${feedback}` : feedback
    }

    bubbles.value.push({ role: 'assistant', content: reply })
    history.value.push({ role: 'assistant', content: reply })
  } catch (err: any) {
    bubbles.value.push({
      role: 'error',
      content: String(err?.message || err),
    })
  } finally {
    sending.value = false
    await nextTick()
    scrollToBottom()
  }
}
</script>

<template>
  <USlideover
    v-model:open="open"
    title="Invoice assistant"
    description="Tell me who you're billing and for what, and I'll fill in the invoice for you."
    :ui="{ content: 'sm:max-w-md', body: 'p-0 sm:p-0' }"
  >
    <UButton icon="i-lucide-sparkles" variant="soft" color="primary" label="Assistant" class="max-sm:[&>span:last-child]:hidden" aria-label="Assistant" />

    <template #body>
      <div ref="messagesEl" class="h-full overflow-y-auto p-4 space-y-3 text-sm" aria-live="polite">
        <div v-if="!bubbles.length" class="space-y-2">
          <p class="text-xs font-medium uppercase tracking-wide text-dimmed">Try</p>
          <div class="flex flex-wrap gap-2">
            <UButton v-for="s in suggestions" :key="s" size="xs" color="neutral" variant="outline" :label="s" @click="ask(s)" />
          </div>
        </div>
        <div
          v-for="(bubble, index) in bubbles"
          :key="index"
          class="flex"
          :class="bubble.role === 'user' ? 'justify-end' : 'justify-start'"
        >
          <div
            class="max-w-[85%] rounded-lg px-3 py-2"
            :style="bubble.role === 'assistant' ? undefined : 'white-space: pre-wrap'"
            :class="{
              'bg-primary text-inverted': bubble.role === 'user',
              'bg-elevated border border-default': bubble.role === 'assistant',
              'text-muted italic': bubble.role === 'system',
              'bg-error/10 text-error border border-error/20': bubble.role === 'error',
            }"
          >
            <ChatMarkdown v-if="bubble.role === 'assistant'" :text="bubble.content" />
            <template v-else>{{ bubble.content }}</template>
          </div>
        </div>
        <div v-if="sending" class="flex items-center gap-2 text-dimmed">
          <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" /> Updating invoice…
        </div>
      </div>
    </template>

    <template #footer>
      <form class="flex w-full items-end gap-2" @submit.prevent="sendMessage">
        <UTextarea
          v-model="draft"
          class="flex-1"
          :rows="2"
          autoresize
          :maxrows="8"
          placeholder="e.g. Bill Acme Pty Ltd, Cape Town — 10 hours design at R850"
          :disabled="sending"
          @keydown.meta.enter.prevent="sendMessage"
          @keydown.ctrl.enter.prevent="sendMessage"
        />
        <UButton type="submit" icon="i-lucide-send" :loading="sending" :disabled="!draft.trim()" aria-label="Send" />
      </form>
    </template>
  </USlideover>
</template>
