const admin = require("firebase-admin");

let app;
// Test hooks: lets unit tests inject an in-memory Firestore and token verifier.
let overrideDb = null;
let overrideVerify = null;

function usingEmulators() {
  return Boolean(process.env.FIRESTORE_EMULATOR_HOST);
}

function firebaseConfigured() {
  if (overrideDb) return true;
  if (!process.env.FIREBASE_PROJECT_ID) return false;
  // Emulators need no credentials (firebase-admin reads *_EMULATOR_HOST itself).
  if (usingEmulators()) return true;
  return Boolean(
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
      process.env.GOOGLE_APPLICATION_CREDENTIALS
  );
}

function getAdmin() {
  if (app) return admin;
  if (!firebaseConfigured() || overrideDb) return null;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const opts = { projectId };

  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON && !usingEmulators()) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    const parsed = JSON.parse(raw);
    opts.credential = admin.credential.cert(parsed);
  }

  app = admin.apps.length ? admin.app() : admin.initializeApp(opts);
  return admin;
}

function getDb() {
  if (overrideDb) return overrideDb;
  const sdk = getAdmin();
  if (!sdk) return null;
  return sdk.firestore();
}

async function verifyIdToken(token) {
  if (overrideVerify) return overrideVerify(token);
  const sdk = getAdmin();
  if (!sdk) throw new Error("Firebase is not configured");
  return sdk.auth().verifyIdToken(token);
}

function __setTestOverrides({ db = null, verifyIdToken: verify = null } = {}) {
  overrideDb = db;
  overrideVerify = verify;
}

module.exports = {
  firebaseConfigured,
  getAdmin,
  getDb,
  verifyIdToken,
  usingEmulators,
  __setTestOverrides,
};
