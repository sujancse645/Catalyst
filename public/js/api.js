/**
 * Fetch wrapper: same-origin cookies, CSRF header, JSON in/out, friendly errors.
 */
export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => {
  onUnauthorized = fn;
};

export async function api(path, { method = 'GET', body, signal } = {}) {
  const init = {
    method,
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    signal,
  };
  if (method !== 'GET') init.headers['X-Requested-With'] = 'SaathiCare';
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, 'You seem to be offline. Please check your internet connection.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/session')) onUnauthorized();
    throw new ApiError(res.status, data?.error?.message || 'Something went wrong', data?.error?.details);
  }
  return data;
}
