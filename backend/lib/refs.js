function companyRef(db, companyId) {
  return db.collection("companies").doc(companyId);
}

module.exports = { companyRef };
