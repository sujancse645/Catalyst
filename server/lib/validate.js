/**
 * Tiny, dependency-free schema validation.
 * Every validator is `(value, path) => parsedValue` and throws HttpError(400) on failure.
 * Object validators strip unknown keys, so clients can never inject extra fields.
 */
import { badRequest } from './errors.js';

const fail = (path, message) => {
  throw badRequest(`${path || 'input'} ${message}`, { field: path });
};

const isBlank = (value) => value === undefined || value === null || value === '';

export const v = {
  string({ min = 1, max = 200, pattern, trim = true } = {}) {
    return (value, path) => {
      if (typeof value !== 'string') fail(path, 'must be text');
      const out = trim ? value.trim() : value;
      if (out.length < min) fail(path, min === 1 ? 'is required' : `must be at least ${min} characters`);
      if (out.length > max) fail(path, `must be at most ${max} characters`);
      if (pattern && !pattern.test(out)) fail(path, 'has an invalid format');
      return out;
    };
  },

  integer({ min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
    return (value, path) => {
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (!Number.isInteger(n)) fail(path, 'must be a whole number');
      if (n < min || n > max) fail(path, `must be between ${min} and ${max}`);
      return n;
    };
  },

  boolean() {
    return (value, path) => {
      if (typeof value !== 'boolean') fail(path, 'must be true or false');
      return value;
    };
  },

  enum(values) {
    return (value, path) => {
      if (!values.includes(value)) fail(path, `must be one of: ${values.join(', ')}`);
      return value;
    };
  },

  email() {
    const base = v.string({ max: 254, pattern: /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[a-z]{2,}$/i });
    return (value, path) => base(value, path).toLowerCase();
  },

  /** Calendar date in YYYY-MM-DD form that actually exists. */
  date() {
    return (value, path) => {
      const s = v.string({ max: 10, pattern: /^\d{4}-\d{2}-\d{2}$/ })(value, path);
      const d = new Date(`${s}T00:00:00Z`);
      if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) fail(path, 'is not a real date');
      return s;
    };
  },

  /** 24h clock time HH:MM. */
  time() {
    return v.string({ max: 5, pattern: /^([01]\d|2[0-3]):[0-5]\d$/ });
  },

  /** ISO-8601 timestamp; returns a normalised ISO string. */
  datetime() {
    return (value, path) => {
      const s = v.string({ max: 40 })(value, path);
      const d = new Date(s);
      if (Number.isNaN(d.getTime())) fail(path, 'is not a valid date and time');
      return d.toISOString();
    };
  },

  array(item, { min = 0, max = 50, unique = false } = {}) {
    return (value, path) => {
      if (!Array.isArray(value)) fail(path, 'must be a list');
      if (value.length < min) fail(path, `needs at least ${min} item(s)`);
      if (value.length > max) fail(path, `can have at most ${max} items`);
      const out = value.map((x, i) => item(x, `${path}[${i}]`));
      if (unique && new Set(out).size !== out.length) fail(path, 'must not contain duplicates');
      return out;
    };
  },

  object(shape) {
    return (value, path) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, 'must be an object');
      const out = {};
      for (const [key, validator] of Object.entries(shape)) {
        const parsed = validator(value[key], path ? `${path}.${key}` : key);
        if (parsed !== undefined) out[key] = parsed;
      }
      return out;
    };
  },

  /** Make any validator optional: blank values become `undefined` (or `fallback`). */
  optional(validator, fallback) {
    return (value, path) => (isBlank(value) ? fallback : validator(value, path));
  },

  /** Allow explicit `null` (used to clear a field on PATCH). */
  nullable(validator) {
    return (value, path) => (value === null ? null : validator(value, path));
  },
};

/** Validate and return a parsed copy. */
export function parse(schema, value) {
  return schema(value ?? {}, '');
}

/** Build a PATCH schema: every field optional, at least one present. */
export function partial(shape) {
  const optionalShape = Object.fromEntries(
    Object.entries(shape).map(([k, fn]) => [k, (val, p) => (val === undefined ? undefined : fn(val, p))]),
  );
  const obj = v.object(optionalShape);
  return (value, path) => {
    const out = obj(value, path);
    if (Object.keys(out).length === 0) fail(path, 'must include at least one field to change');
    return out;
  };
}
