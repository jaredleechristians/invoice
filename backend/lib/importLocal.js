const { createCustomer } = require("./customers");
const { createInvoice } = require("./invoices");

function formatBillTo(billTo) {
  if (typeof billTo === "string") return billTo.trim();
  if (billTo && typeof billTo === "object") {
    const name = String(billTo.name || "").trim();
    const details = String(billTo.details || "").trim();
    return [name, details].filter(Boolean).join("\n");
  }
  return "";
}

function mapLocalInvoiceToPayload(local) {
  const billToText = formatBillTo(local.billTo);
  const billToName =
    local.billTo && typeof local.billTo === "object"
      ? String(local.billTo.name || "").trim()
      : billToText.split("\n")[0] || "";

  const items = (local.items || []).map((item) => ({
    description: String(item.description || ""),
    note: String(item.note || ""),
    qty: Number(item.qty) || 0,
    unitPrice: Number(item.unitPrice) || 0,
  }));

  return {
    billToName,
    body: {
      issueDate: local.issueDate || "",
      dueDate: local.dueDate || "",
      billTo: billToText,
      customerName: billToName,
      items,
      notes: local.notes || "",
      banking: local.banking || null,
      legal: local.legal || "",
      footer: "",
      payload: local,
      draft: false,
    },
  };
}

async function importLocalInvoice(companyId, uid, email, role, localInvoice) {
  const { billToName, body } = mapLocalInvoiceToPayload(localInvoice);
  let customerId = "";

  if (billToName) {
    const { listCustomers } = require("./customers");
    const existing = (await listCustomers(companyId)).find(
      (c) => c.name.toLowerCase() === billToName.toLowerCase()
    );
    if (existing) {
      customerId = existing.id;
    } else {
      const created = await createCustomer(companyId, uid, email, role, {
        name: billToName,
        email: "",
        phone: "",
        address:
          localInvoice.billTo && typeof localInvoice.billTo === "object"
            ? String(localInvoice.billTo.details || "")
            : "",
      });
      customerId = created.id;
    }
  }

  if (customerId) body.customerId = customerId;
  return createInvoice(companyId, uid, email, role, body);
}

module.exports = { importLocalInvoice, mapLocalInvoiceToPayload };
