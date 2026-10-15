const admin = require("firebase-admin");

let app;

function firebaseConfigured() {
  return Boolean(
    process.env.FIREBASE_PROJECT_ID &&
      (process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
        process.env.GOOGLE_APPLICATION_CREDENTIALS)
  );
}

function getAdmin() {
  if (app) return admin;
  if (!firebaseConfigured()) return null;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const opts = { projectId };

  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    const parsed = JSON.parse(raw);
    opts.credential = admin.credential.cert(parsed);
  }

  app = admin.apps.length ? admin.app() : admin.initializeApp(opts);
  return admin;
}

function getDb() {
  const sdk = getAdmin();
  if (!sdk) return null;
  return sdk.firestore();
}

module.exports = { firebaseConfigured, getAdmin, getDb };
