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
    content: 'Ask me to update bill to, line items, notes, banking, or dates.',
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
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: history.value,
        invoice: invoice.value,
      }),
    })

    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new Error(data?.error || data?.detail || `HTTP ${res.status}`)
    }

    const parsed = parseAssistantPayload(String(data.content || ''))
    if (parsed.invoice) {
      applyInvoice(parsed.invoice)
    }

    const reply = parsed.message || 'Done.'
    bubbles.value.push({ role: 'assistant', content: reply })
    history.value.push({ role: 'assistant', content: String(data.content || reply) })
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
