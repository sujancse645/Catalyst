/**
 * Tiny DOM helpers. Text is always set via textContent — never innerHTML —
 * so user data and AI output can never inject markup.
 */

/**
 * h('button', { class: 'big', onclick }, 'Label', childNode)
 * @param {string} tag
 * @param {Record<string, any>} [attrs]
 * @param {...any} children
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === false || value === null || value === undefined) continue;
    if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    // CSSOM assignment is permitted under our strict CSP (style attributes are not).
    else if (key === 'style') el.style.cssText = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key in el && typeof value !== 'string') el[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export const clear = (el) => {
  el.replaceChildren();
  return el;
};

let uid = 0;
export const nextId = (prefix = 'id') => `${prefix}-${(uid += 1)}`;

/** Labelled form field with optional hint; returns the wrapper. */
export function field({ label, hint, input }) {
  const id = input.id || nextId('f');
  input.id = id;
  const hintId = hint ? `${id}-hint` : null;
  if (hintId) input.setAttribute('aria-describedby', hintId);
  return h(
    'div',
    { class: 'field' },
    h('label', { for: id }, label, hint ? h('span', { class: 'hint', id: hintId }, ` — ${hint}`) : null),
    input,
  );
}

/** Announce a message to screen readers and show a toast. */
export function toast(message, { error = false } = {}) {
  const region = document.getElementById('toast-region');
  const node = h('div', { class: `toast${error ? ' error' : ''}` }, message);
  // Keep at most two toasts so they never pile up over the content.
  while (region.children.length >= 2) region.firstElementChild.remove();
  region.append(node);
  if (error) document.getElementById('alert-region').textContent = message;
  setTimeout(() => node.remove(), error ? 7000 : 4500);
}

/**
 * Accessible modal dialog using the native <dialog> element
 * (focus trapping and Escape handling come for free).
 */
export function openDialog({ title, body, actions = [], onClose }) {
  const titleId = nextId('dlg');
  const close = () => dialog.close();
  const dialog = h(
    'dialog',
    { 'aria-labelledby': titleId },
    h('div', { class: 'dialog-body' }, h('h2', { id: titleId, style: 'margin-top:0' }, title), body),
    h(
      'div',
      { class: 'dialog-actions' },
      actions.map((a) =>
        h('button', { type: a.type || 'button', class: a.class || '', form: a.form, onclick: a.onClick }, a.label),
      ),
      h('button', { type: 'button', class: 'secondary', onclick: close }, actions.length ? 'Cancel' : 'Close'),
    ),
  );
  dialog.addEventListener('close', () => {
    dialog.remove();
    onClose?.();
  });
  document.body.append(dialog);
  dialog.showModal();
  return { dialog, close };
}

/** Promise-based, non-blocking confirmation dialog. */
export function confirmDialog(title, message, confirmLabel = 'Yes, continue', danger = false) {
  return new Promise((resolve) => {
    let result = false;
    const { close } = openDialog({
      title,
      body: h('p', {}, message),
      actions: [
        {
          label: confirmLabel,
          class: danger ? 'danger' : '',
          onClick: () => {
            result = true;
            close();
          },
        },
      ],
      onClose: () => resolve(result),
    });
  });
}

/** Run an async action with a busy button state. */
export async function withBusy(button, fn) {
  const original = [...button.childNodes];
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.replaceChildren(h('span', { class: 'spinner', 'aria-hidden': 'true' }), ' Please wait…');
  try {
    return await fn();
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.replaceChildren(...original);
  }
}

export const fmt = {
  date(iso, tz) {
    return new Intl.DateTimeFormat('en-IN', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(
      new Date(iso),
    );
  },
  dateTime(iso, tz) {
    return new Intl.DateTimeFormat('en-IN', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(iso),
    );
  },
  time12(hhmm) {
    const [hRaw, m] = hhmm.split(':').map(Number);
    const suffix = hRaw >= 12 ? 'PM' : 'AM';
    const hr = hRaw % 12 || 12;
    return `${hr}:${String(m).padStart(2, '0')} ${suffix}`;
  },
  relative(iso) {
    const diff = new Date(iso).getTime() - Date.now();
    const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
    const mins = Math.round(diff / 60000);
    if (Math.abs(mins) < 60) return rtf.format(mins, 'minute');
    const hours = Math.round(mins / 60);
    if (Math.abs(hours) < 36) return rtf.format(hours, 'hour');
    return rtf.format(Math.round(hours / 24), 'day');
  },
};

/** datetime-local input value (local to the browser) ↔ ISO */
export const toLocalInput = (iso) => {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** Replace an element's content; accepts nested arrays and null like h(). */
export function fill(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}
