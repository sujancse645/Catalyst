/**
 * Minimal Google Cloud Firestore client over the REST API.
 * On Cloud Run, credentials come from the metadata server (the service's
 * own service account) — no key files are ever stored in the repo.
 */

const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

/** Encode a JS value as a Firestore typed Value. */
export function encodeValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (typeof value === 'string') return { stringValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeValue) } };
  if (typeof value === 'object') return { mapValue: { fields: encodeFields(value) } };
  throw new TypeError(`Unsupported Firestore value: ${typeof value}`);
}

export function encodeFields(obj) {
  const fields = {};
  for (const [k, val] of Object.entries(obj)) if (val !== undefined) fields[k] = encodeValue(val);
  return fields;
}

/** Decode a Firestore typed Value back into plain JS. */
export function decodeValue(v) {
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeValue);
  if ('mapValue' in v) return decodeFields(v.mapValue.fields || {});
  return null;
}

export function decodeFields(fields = {}) {
  const out = {};
  for (const [k, val] of Object.entries(fields)) out[k] = decodeValue(val);
  return out;
}

export function createFirestoreStore({ projectId, fetchImpl = fetch, database = '(default)' }) {
  if (!projectId) throw new Error('GOOGLE_CLOUD_PROJECT is required for the firestore store');
  const root = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${database}/documents`;
  let cached = { token: '', expiresAt: 0 };

  async function token() {
    if (cached.token && cached.expiresAt > Date.now() + 60_000) return cached.token;
    const res = await fetchImpl(METADATA_TOKEN_URL, { headers: { 'Metadata-Flavor': 'Google' } });
    if (!res.ok) throw new Error(`metadata token request failed: ${res.status}`);
    const json = await res.json();
    cached = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
    return cached.token;
  }

  async function call(url, init = {}) {
    const res = await fetchImpl(url, {
      ...init,
      headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    return res;
  }

  const docUrl = (col, id) => `${root}/${encodeURIComponent(col)}/${encodeURIComponent(id)}`;
  const toDoc = (json) => (json?.fields ? decodeFields(json.fields) : null);

  async function write(col, id, doc, precondition) {
    const qs = precondition ? `?currentDocument.exists=${precondition}` : '';
    const res = await call(docUrl(col, id) + qs, {
      method: 'PATCH',
      body: JSON.stringify({ fields: encodeFields({ ...doc, id }) }),
    });
    return res;
  }

  return {
    driver: 'firestore',
    async get(col, id) {
      const res = await call(docUrl(col, id));
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`firestore get ${col} failed: ${res.status}`);
      return toDoc(await res.json());
    },
    async set(col, id, doc) {
      const res = await write(col, id, doc);
      if (!res.ok) throw new Error(`firestore set ${col} failed: ${res.status}`);
      return toDoc(await res.json());
    },
    async setIfAbsent(col, id, doc) {
      const res = await write(col, id, doc, 'false');
      if (res.ok) return true;
      if (res.status === 409 || res.status === 400) return false; // ALREADY_EXISTS / FAILED_PRECONDITION
      throw new Error(`firestore setIfAbsent ${col} failed: ${res.status}`);
    },
    async update(col, id, patch) {
      const existing = await this.get(col, id);
      if (!existing) return null;
      return this.set(col, id, { ...existing, ...patch });
    },
    async delete(col, id) {
      const res = await call(docUrl(col, id), { method: 'DELETE' });
      return res.ok;
    },
    async find(col, where = {}) {
      const filters = Object.entries(where).map(([field, value]) => ({
        fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: encodeValue(value) },
      }));
      const structuredQuery = { from: [{ collectionId: col }] };
      if (filters.length === 1) structuredQuery.where = filters[0];
      if (filters.length > 1) structuredQuery.where = { compositeFilter: { op: 'AND', filters } };
      const res = await call(`${root}:runQuery`, { method: 'POST', body: JSON.stringify({ structuredQuery }) });
      if (!res.ok) throw new Error(`firestore query ${col} failed: ${res.status}`);
      const rows = await res.json();
      return rows.filter((r) => r.document).map((r) => toDoc(r.document));
    },
  };
}
