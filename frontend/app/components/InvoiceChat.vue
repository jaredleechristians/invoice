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
const bubbles = ref<ChatBubble[]>([
  {
    role: 'system',
    content: 'Try “Create an invoice for …” or ask me to update bill to, line items, notes, banking, or dates. Unsaved form edits are kept unless you ask to change them.',
  },
])

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
    // Snapshot what the model sees so we only apply fields it actually changed.
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
      throw new Error(data?.error || data?.detail || `HTTP ${res.status}`)
    }

    // Prefer structured fields from the API; fall back to parsing raw content.
    let message = typeof data.message === 'string' ? data.message.trim() : ''
    let nextInvoice = data.invoice && typeof data.invoice === 'object' ? data.invoice : null

    if (!message || !nextInvoice) {
      const parsed = parseAssistantPayload(String(data.content || ''))
      if (!message) message = parsed.message
      if (!nextInvoice) nextInvoice = parsed.invoice
    }

    if (nextInvoice) {
      applyInvoice(nextInvoice, sentInvoice)
    }

    const reply = message || (nextInvoice ? 'Invoice updated.' : 'Done.')
    bubbles.value.push({ role: 'assistant', content: reply })
    // Keep history as the short reply so later turns don't re-feed giant JSON.
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
  <div>
    <button
      type="button"
      class="chat-fab"
      :aria-expanded="open"
      aria-controls="chatPanel"
      aria-label="Open invoice assistant"
      @click="open = !open"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M21 15a4 4 0 0 1-4 4H7l-4 4V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" />
      </svg>
    </button>

    <aside
      v-show="open"
      id="chatPanel"
      class="chat-panel"
      aria-label="Invoice assistant"
    >
      <div class="chat-header">
        <div>
          <h2>Invoice assistant</h2>
        </div>
        <button type="button" class="chat-close" aria-label="Close chat" @click="open = false">
          ×
        </button>
      </div>

      <div ref="messagesEl" class="chat-messages" aria-live="polite">
        <div
          v-for="(bubble, index) in bubbles"
          :key="index"
          class="chat-bubble"
          :class="bubble.role"
        >
          {{ bubble.content }}
        </div>
      </div>

      <form class="chat-composer" @submit.prevent="sendMessage">
        <textarea
          v-model="draft"
          rows="3"
          placeholder="e.g. Change bill to Acme Pty Ltd, Cape Town"
          required
          @keydown.meta.enter.prevent="sendMessage"
          @keydown.ctrl.enter.prevent="sendMessage"
        />
        <div class="chat-composer-row">
          <button type="submit" class="btn" :disabled="sending">
            {{ sending ? 'Thinking…' : 'Send' }}
          </button>
        </div>
      </form>
    </aside>
  </div>
</template>
