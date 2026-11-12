// Minimal in-memory Firestore stand-in for unit tests (subset of the Admin SDK API).
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
let autoId = 0;

class DocSnap {
  constructor(ref, data) {
    this.ref = ref;
    this.id = ref.id;
    this._data = data;
    this.exists = data !== undefined;
  }
  data() {
    return clone(this._data);
  }
}

class QuerySnap {
  constructor(docs) {
    this.docs = docs;
    this.size = docs.length;
    this.empty = docs.length === 0;
  }
  forEach(fn) {
    this.docs.forEach(fn);
  }
}

class DocRef {
  constructor(db, path) {
    this._db = db;
    this.path = path;
    const parts = path.split("/");
    this.id = parts[parts.length - 1];
  }
  get parent() {
    return new CollectionRef(this._db, this.path.split("/").slice(0, -1).join("/"));
  }
  collection(name) {
    return new CollectionRef(this._db, `${this.path}/${name}`);
  }
  async get() {
    return new DocSnap(this, clone(this._db._store.get(this.path)));
  }
  async set(data, opts) {
    this._db._write(this.path, data, opts);
  }
  async update(data) {
    if (!this._db._store.has(this.path)) throw new Error(`No document to update: ${this.path}`);
    this._db._write(this.path, data, { merge: true });
  }
  async delete() {
    this._db._store.delete(this.path);
  }
  async create(data) {
    if (this._db._store.has(this.path)) {
      const err = new Error(`Already exists: ${this.path}`);
      err.code = 6;
      throw err;
    }
    this._db._write(this.path, data);
  }
}

function getField(data, field) {
  return String(field || "").split(".").reduce((o, k) => (o == null ? o : o[k]), data);
}

const OPS = {
  "==": (a, b) => a === b,
  "!=": (a, b) => a !== b,
  "<": (a, b) => a < b,
  "<=": (a, b) => a <= b,
  ">": (a, b) => a > b,
  ">=": (a, b) => a >= b,
  in: (a, b) => b.includes(a),
  "array-contains": (a, b) => Array.isArray(a) && a.includes(b),
};

class Query {
  constructor(db, matcher, state = {}) {
    this._db = db;
    this._matcher = matcher;
    this._state = { filters: [], orders: [], limit: null, startAfter: null, ...state };
  }
  _with(patch) {
    return new Query(this._db, this._matcher, { ...this._state, ...patch });
  }
  where(field, op, value) {
    if (!OPS[op]) throw new Error(`Unsupported op ${op}`);
    return this._with({ filters: [...this._state.filters, { field, op, value }] });
  }
  orderBy(field, dir = "asc") {
    return this._with({ orders: [...this._state.orders, { field, dir }] });
  }
  limit(n) {
    return this._with({ limit: n });
  }
  startAfter(snap) {
    return this._with({ startAfter: snap });
  }
  async get() {
    const { filters, orders, limit, startAfter } = this._state;
    let docs = [];
    for (const [path, data] of this._db._store.entries()) {
      if (!this._matcher(path)) continue;
      if (!filters.every((f) => OPS[f.op](getField(data, f.field), f.value))) continue;
      docs.push(new DocSnap(new DocRef(this._db, path), clone(data)));
    }
    docs.sort((a, b) => {
      for (const o of orders) {
        const va = getField(a._data, o.field);
        const vb = getField(b._data, o.field);
        if (va === vb) continue;
        const cmp = va < vb ? -1 : 1;
        return o.dir === "desc" ? -cmp : cmp;
      }
      return a.ref.path < b.ref.path ? -1 : a.ref.path > b.ref.path ? 1 : 0;
    });
    if (startAfter) {
      const idx = docs.findIndex((d) => d.ref.path === startAfter.ref.path);
      docs = docs.slice(idx + 1);
    }
    if (limit != null) docs = docs.slice(0, limit);
    this._db.reads += docs.length;
    return new QuerySnap(docs);
  }
}

class CollectionRef extends Query {
  constructor(db, path) {
    super(db, (p) => {
      const parts = p.split("/");
      return parts.slice(0, -1).join("/") === path;
    });
    this.path = path;
    this.id = path.split("/").pop();
  }
  get parent() {
    const parts = this.path.split("/");
    return parts.length > 1 ? new DocRef(this._db, parts.slice(0, -1).join("/")) : null;
  }
  doc(id) {
    return new DocRef(this._db, `${this.path}/${id || `auto${++autoId}`}`);
  }
  async add(data) {
    const ref = this.doc();
    await ref.set(data);
    return ref;
  }
}

class FakeFirestore {
  constructor() {
    this._store = new Map();
    this.reads = 0;
    this._txQueue = Promise.resolve();
  }
  _write(path, data, opts) {
    const prev = this._store.get(path);
    const next = opts?.merge && prev ? { ...prev, ...clone(data) } : clone(data);
    this._store.set(path, next);
  }
  collection(name) {
    return new CollectionRef(this, name);
  }
  doc(path) {
    return new DocRef(this, path);
  }
  collectionGroup(name) {
    return new Query(this, (p) => {
      const parts = p.split("/");
      return parts.length >= 2 && parts[parts.length - 2] === name;
    });
  }
  batch() {
    const ops = [];
    return {
      set: (ref, data, opts) => ops.push(() => this._write(ref.path, data, opts)),
      update: (ref, data) => ops.push(() => this._write(ref.path, data, { merge: true })),
      delete: (ref) => ops.push(() => this._store.delete(ref.path)),
      commit: async () => ops.forEach((op) => op()),
    };
  }
  // Transactions are serialised, mimicking Firestore's serializable isolation.
  runTransaction(fn) {
    const run = this._txQueue.then(() => this._runTransaction(fn));
    this._txQueue = run.catch(() => {});
    return run;
  }
  async _runTransaction(fn) {
    const ops = [];
    let wrote = false;
    const tx = {
      get: async (refOrQuery) => {
        if (wrote) throw new Error("Transaction reads must happen before writes");
        return refOrQuery.get();
      },
      set: (ref, data, opts) => {
        wrote = true;
        ops.push(() => this._write(ref.path, data, opts));
      },
      update: (ref, data) => {
        wrote = true;
        ops.push(() => this._write(ref.path, data, { merge: true }));
      },
      delete: (ref) => {
        wrote = true;
        ops.push(() => this._store.delete(ref.path));
      },
      create: (ref, data) => {
        wrote = true;
        ops.push(() => {
          if (this._store.has(ref.path)) {
            const err = new Error(`Already exists: ${ref.path}`);
            err.code = 6;
            throw err;
          }
          this._write(ref.path, data);
        });
      },
    };
    const result = await fn(tx);
    ops.forEach((op) => op());
    return result;
  }
  dump(prefix = "") {
    return [...this._store.entries()].filter(([p]) => p.startsWith(prefix));
  }
}

module.exports = { FakeFirestore };
