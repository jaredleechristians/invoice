const { FakeFirestore } = require("./fakeFirestore");
const firebase = require("../../lib/firebase");

/** Fresh fake DB + token verifier where the bearer token is "uid:email". */
function setupFake() {
  const db = new FakeFirestore();
  firebase.__setTestOverrides({
    db,
    verifyIdToken: async (token) => {
      const [uid, email] = String(token).split(":");
      if (!uid) throw new Error("bad token");
      return { uid, email: email || `${uid}@example.com`, name: uid };
    },
  });
  return db;
}

module.exports = { setupFake };
