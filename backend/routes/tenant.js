const express = require("express");
const { firebaseConfigured } = require("../lib/firebase");
const { requireUser, requireMember, httpError } = require("../lib/auth");
const companies = require("../lib/companies");
const customers = require("../lib/customers");
const invoices = require("../lib/invoices");
const payments = require("../lib/payments");
const { buildStatement } = require("../lib/statements");
const { listReceivables } = require("../lib/receivables");
const { importLocalInvoice } = require("../lib/importLocal");
const { renderStatementHtml } = require("../lib/statementHtml");
const { htmlToPdfBuffer } = require("../lib/pdf");
const { runTenantChat } = require("../lib/tenantChat");

const router = express.Router();

router.use((req, res, next) => {
  if (!firebaseConfigured()) {
    return res.status(503).json({
      error: "Signed-in features are not configured (Firebase is missing).",
    });
  }
  next();
});

router.get("/me", requireUser, async (req, res) => {
  try {
    const list = await companies.listCompaniesForUser(req.user.uid);
    res.json({ user: req.user, companies: list });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post("/bootstrap", requireUser, async (req, res) => {
  try {
    const result = await companies.bootstrapUser({
      uid: req.user.uid,
      email: req.user.email,
      displayName: req.user.name,
    });
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post("/companies", requireUser, async (req, res) => {
  try {
    const company = await companies.createCompany({
      uid: req.user.uid,
      email: req.user.email,
      name: req.body.name,
    });
    res.status(201).json(company);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post("/invites/:token/accept", requireUser, async (req, res) => {
  try {
    const result = await companies.acceptInvite(
      req.params.token,
      req.user.uid,
      req.user.email
    );
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get(
  "/companies/:companyId",
  requireUser,
  requireMember,
  async (req, res) => {
    try {
      const db = require("../lib/firebase").getDb();
      const snap = await companies.companyRef(db, req.companyId).get();
      if (!snap.exists) throw httpError(404, "Company not found");
      res.json({ id: snap.id, ...snap.data(), role: req.role });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  }
);

router.patch(
  "/companies/:companyId",
  requireUser,
  requireMember,
  async (req, res) => {
    try {
      const updated = await companies.updateCompanySettings(
        req.companyId,
        req.user.uid,
        req.user.email,
        req.role,
        req.body
      );
      res.json(updated);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  }
);

router.post(
  "/companies/:companyId/invites",
  requireUser,
  requireMember,
  async (req, res) => {
    try {
      const invite = await companies.createInvite(
        req.companyId,
        req.user.uid,
        req.user.email,
        req.role,
        { email: req.body.email, role: req.body.role }
      );
      res.status(201).json(invite);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  }
);

router.get(
  "/companies/:companyId/customers",
  requireUser,
  requireMember,
  async (req, res) => {
    try {
      const rows = await customers.listCustomers(req.companyId, {
        q: req.query.q,
      });
      res.json({ customers: rows });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  }
);

router.post(
  "/companies/:companyId/customers",
  requireUser,
  requireMember,
  async (req, res) => {
    try {
      const row = await customers.createCustomer(
        req.companyId,
        req.user.uid,
        req.user.email,
        req.role,
        req.body
      );
      res.status(201).json(row);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  }
);

router.patch(
  "/companies/:companyId/customers/:customerId",
  requireUser,
  requireMember,
  async (req, res) => {
    try {
      const row = await customers.updateCustomer(
        req.companyId,
        req.user.uid,
        req.user.email,
        req.role,
        req.params.customerId,
        req.body
      );
      res.json(row);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  }
);

router.delete(
  "/companies/:companyId/customers/:customerId",
  requireUser,
  requireMember,
  async (req, res) => {
    try {
      await customers.deleteCustomer(
        req.companyId,
        req.user.uid,
        req.user.email,
        req.role,
        req.params.customerId
      );
      res.json({ ok: true });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  }
);

router.get(
  "/companies/:companyId/invoices",
  requireUser,
  requireMember,
  async (req, res) => {
    try {
      const rows = await invoices.listInvoices(req.companyId, {
        q: req.query.q,
        status: req.query.status,
        customerId: req.query.customerId,
      });
      res.json({ invoices: rows });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  }
);

router.get(
  "/companies/:companyId/invoices/:invoiceId",
  requireUser,
  requireMember,
  async (req, res) => {
    try {
      const row = await invoices.getInvoice(
        req.companyId,
        req.params.invoiceId
      );
      if (!row) throw httpError(404, "Invoice not found");
      res.json(row);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  }
);

router.post(
  "/companies/:companyId/invoices",
  requireUser,
  requireMember,
  async (req, res) => {
    try {
      const row = await invoices.createInvoice(
        req.companyId,
        req.user.uid,
        req.user.email,
        req.role,
        req.body
      );
      res.status(201).json(row);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  }
);

router.patch(
  "/companies/:companyId/invoices/:invoiceId",
  requireUser,
  requireMember,
  async (req, res) => {
    try {
      const row = await invoices.updateInvoice(
        req.companyId,
        req.user.uid,
        req.user.email,
        req.role,
        req.params.invoiceId,
        req.body
      );
      res.json(row);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  }
);

router.delete(
  "/companies/:companyId/invoices/:invoiceId",
  requireUser,
  requireMember,
  async (req, res) => {
    try {
      await invoices.deleteInvoice(
        req.companyId,
        req.user.uid,
        req.user.email,
        req.role,
        req.params.invoiceId
      );
      res.json({ ok: true });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  }
);

router.get(
  "/companies/:companyId/payments",
  requireUser,
  requireMember,
  async (req, res) => {
    try {
      const rows = await payments.listPayments(req.companyId, {
        invoiceId: req.query.invoiceId,
      });
      res.json({ payments: rows });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  }
);

router.post(
  "/companies/:companyId/payments",
  requireUser,
  requireMember,
  async (req, res) => {
    try {
      const result = await payments.recordPayment(
        req.companyId,
        req.user.uid,
        req.user.email,
        req.role,
        req.body
      );
      res.status(201).json(result);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  }
);

router.get(
  "/companies/:companyId/customers/:customerId/statement",
  requireUser,
  requireMember,
  async (req, res) => {
    try {
      const statement = await buildStatement(
        req.companyId,
        req.params.customerId,
        { asOf: req.query.asOf }
      );
      res.json(statement);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  }
);

router.get(
  "/companies/:companyId/customers/:customerId/statement.pdf",
  requireUser,
  requireMember,
  async (req, res) => {
    try {
      const statement = await buildStatement(
        req.companyId,
        req.params.customerId,
        { asOf: req.query.asOf }
      );
      const db = require("../lib/firebase").getDb();
      const companySnap = await companies.companyRef(db, req.companyId).get();
      const companyName = companySnap.exists ? companySnap.data().name : "";
      const html = renderStatementHtml(statement, { companyName });
      const safeName = (statement.customer?.name || "statement")
        .replace(/[^\w.-]+/g, "-")
        .slice(0, 40);
      const { buffer } = await htmlToPdfBuffer(html, {
        filename: `${safeName}-statement.pdf`,
      });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${safeName}-statement.pdf"`
      );
      res.send(buffer);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  }
);

router.get(
  "/companies/:companyId/receivables",
  requireUser,
  requireMember,
  async (req, res) => {
    try {
      const rows = await listReceivables(req.companyId);
      res.json({ receivables: rows });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  }
);

router.post(
  "/companies/:companyId/invoices/import-local",
  requireUser,
  requireMember,
  async (req, res) => {
    try {
      const invoice = await importLocalInvoice(
        req.companyId,
        req.user.uid,
        req.user.email,
        req.role,
        req.body?.invoice || req.body
      );
      res.status(201).json(invoice);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  }
);

router.post(
  "/companies/:companyId/assistant",
  requireUser,
  requireMember,
  async (req, res) => {
    try {
      const messages = req.body?.messages;
      if (!Array.isArray(messages) || !messages.length) {
        throw httpError(400, "messages array is required");
      }
      const result = await runTenantChat({
        companyId: req.companyId,
        uid: req.user.uid,
        email: req.user.email,
        messages,
      });
      res.json(result);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  }
);

module.exports = router;
