/**
 * Storage abstraction. Two drivers share one async interface:
 *   - memory   : in-process Maps, optional JSON-file persistence (local dev, tests)
 *   - firestore: Google Cloud Firestore via REST (production on Cloud Run)
 *
 * Interface:
 *   get(col, id) → doc|null
 *   set(col, id, doc) → doc                 (create or replace)
 *   setIfAbsent(col, id, doc) → boolean     (atomic create; false if it already existed)
 *   update(col, id, patch) → doc|null       (shallow merge)
 *   delete(col, id) → boolean
 *   find(col, where) → doc[]                (equality filters)
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createFirestoreStore } from './firestore.js';

const clone = (x) => structuredClone(x);

export function createMemoryStore({ file = '' } = {}) {
  /** @type {Map<string, Map<string, object>>} */
  const cols = new Map();
  let timer = null;

  if (file) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      for (const [name, docs] of Object.entries(raw)) cols.set(name, new Map(Object.entries(docs)));
    } catch {
      /* first run — no file yet */
    }
  }

  const persist = () => {
    if (!file || timer) return;
    timer = setTimeout(() => {
      timer = null;
      const out = {};
      for (const [name, docs] of cols) out[name] = Object.fromEntries(docs);
      writeFileSync(`${file}.tmp`, JSON.stringify(out));
      renameSync(`${file}.tmp`, file); // atomic replace
    }, 200);
    timer.unref?.();
  };

  const col = (name) => {
    if (!cols.has(name)) cols.set(name, new Map());
    return cols.get(name);
  };

  return {
    driver: 'memory',
    async get(name, id) {
      const doc = col(name).get(id);
      return doc ? clone(doc) : null;
    },
    async set(name, id, doc) {
      const stored = { ...clone(doc), id };
      col(name).set(id, stored);
      persist();
      return clone(stored);
    },
    async setIfAbsent(name, id, doc) {
      if (col(name).has(id)) return false;
      col(name).set(id, { ...clone(doc), id });
      persist();
      return true;
    },
    async update(name, id, patch) {
      const existing = col(name).get(id);
      if (!existing) return null;
      const next = { ...existing, ...clone(patch), id };
      col(name).set(id, next);
      persist();
      return clone(next);
    },
    async delete(name, id) {
      const ok = col(name).delete(id);
      if (ok) persist();
      return ok;
    },
    async find(name, where = {}) {
      const entries = Object.entries(where);
      const out = [];
      for (const doc of col(name).values()) {
        if (entries.every(([k, val]) => doc[k] === val)) out.push(clone(doc));
      }
      return out;
    },
  };
}

export function createStore(config, { fetchImpl } = {}) {
  if (config.storeDriver === 'firestore') {
    return createFirestoreStore({ projectId: config.gcpProject, fetchImpl });
  }
  return createMemoryStore({ file: config.dataFile });
}
