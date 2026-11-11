/** Anonymous editor: render the current invoice to PDF via the API (Gotenberg). */
export function useInvoicePdf() {
  const { invoice } = useInvoice()
  const busy = useState('invoice-pdf-busy', () => false)
  const toast = useToast()

  async function downloadPdf() {
    if (busy.value) return
    busy.value = true
    try {
      const html = buildExportHtml(invoice.value)
      const form = new FormData()
      form.append('files', new Blob([html], { type: 'text/html' }), 'index.html')
      form.append('paperWidth', '8.27')
      form.append('paperHeight', '11.7')
      form.append('marginTop', '0')
      form.append('marginBottom', '0')
      form.append('marginLeft', '0')
      form.append('marginRight', '0')
      form.append('printBackground', 'true')
      form.append('preferCssPageSize', 'false')
      form.append('emulatedMediaType', 'print')

      const res = await fetch('/api/pdf', { method: 'POST', body: form })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(`HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`)
      }

      const blob = await res.blob()
      const filename = `${(invoice.value.invoiceNumber || 'invoice').replace(/[^\w.-]+/g, '_')}.pdf`
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (err: any) {
      console.error(err)
      toast.add({
        title: 'PDF export failed',
        description: `Is the stack running (docker compose up)? ${String(err?.message || err)}`,
        color: 'error',
        icon: 'i-lucide-circle-alert',
      })
    } finally {
      busy.value = false
    }
  }

  return { downloadPdf, pdfBusy: busy }
}
