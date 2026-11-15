/**
 * Landing: explain the product, create a circle, or join one with a passcode.
 */
import { api } from '../api.js';
import { field, h, toast, withBusy } from '../dom.js';

const ROLE_OPTIONS = [
  ['elder', 'I am the elder (this is my care)'],
  ['caretaker', 'I am a caretaker or nurse'],
  ['family', 'I am family'],
];

const roleSelect = (value = 'family') =>
  h(
    'select',
    { name: 'role', required: true },
    ROLE_OPTIONS.map(([v, label]) => h('option', { value: v, selected: v === value }, label)),
  );

const showFieldError = (form, err) => {
  form.querySelectorAll('.field-error').forEach((n) => n.remove());
  form.querySelectorAll('[aria-invalid]').forEach((n) => n.removeAttribute('aria-invalid'));
  const name = err.details?.field;
  const input = name && form.elements.namedItem(name);
  if (input instanceof HTMLElement) {
    input.setAttribute('aria-invalid', 'true');
    const msg = h('p', { class: 'field-error', id: `${input.id}-err` }, err.message);
    input.setAttribute('aria-describedby', msg.id);
    input.after(msg);
    input.focus();
  }
  toast(err.message, { error: true });
};

function joinForm(app, demo) {
  const form = h(
    'form',
    { novalidate: true },
    h(
      'div',
      { class: 'grid-2' },
      field({
        label: 'Circle code',
        hint: '6 letters/numbers',
        input: h('input', { name: 'circleCode', autocomplete: 'off', required: true, maxlength: '6', autocapitalize: 'characters' }),
      }),
      field({
        label: 'Passcode',
        hint: '6 digits',
        input: h('input', { name: 'passcode', type: 'password', inputmode: 'numeric', autocomplete: 'current-password', required: true, maxlength: '6' }),
      }),
    ),
    field({ label: 'Your name', input: h('input', { name: 'name', autocomplete: 'name', required: true }) }),
    field({ label: 'Your email', hint: 'reminders are sent here', input: h('input', { name: 'email', type: 'email', autocomplete: 'email', required: true }) }),
    field({ label: 'Who are you?', input: roleSelect() }),
    h('button', { type: 'submit', class: 'big' }, 'Join care circle'),
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    withBusy(form.querySelector('[type=submit]'), async () => {
      try {
        app.setSession(await api('/api/session', { method: 'POST', body: data }));
        toast(`Welcome, ${data.name}!`);
        app.navigate('today');
      } catch (err) {
        showFieldError(form, err);
      }
    });
  });

  const demoBlock = demo
    ? h(
        'div',
        { class: 'banner info' },
        h('div', {}, h('strong', {}, 'Try the demo: '), 'circle code ', h('span', { class: 'code', style: 'font-size:1rem' }, 'DEMO42'), ', passcode 246810'),
        h(
          'div',
          { class: 'row' },
          h('button', { type: 'button', class: 'secondary', onclick: () => fillDemo(form, 'elder') }, 'Fill as Kamala (elder)'),
          h('button', { type: 'button', class: 'secondary', onclick: () => fillDemo(form, 'family') }, 'Fill as Ravi (son)'),
        ),
      )
    : null;
  return h('div', {}, demoBlock, form);
}

function fillDemo(form, who) {
  const values =
    who === 'elder'
      ? { circleCode: 'DEMO42', passcode: '246810', name: 'Kamala Devi', email: 'kamala@example.com', role: 'elder' }
      : { circleCode: 'DEMO42', passcode: '246810', name: 'Ravi (son)', email: 'ravi@example.com', role: 'family' };
  for (const [k, v] of Object.entries(values)) form.elements.namedItem(k).value = v;
  form.querySelector('[type=submit]').focus();
  toast('Demo details filled in. Press "Join care circle".');
}

function createForm(app) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata';
  const form = h(
    'form',
    { novalidate: true },
    field({ label: "Elder's name", hint: 'the person being cared for', input: h('input', { name: 'elderName', required: true, autocomplete: 'off' }) }),
    h(
      'div',
      { class: 'grid-2' },
      field({ label: 'Your name', input: h('input', { name: 'yourName', autocomplete: 'name', required: true }) }),
      field({ label: 'Your email', input: h('input', { name: 'email', type: 'email', autocomplete: 'email', required: true }) }),
    ),
    field({ label: 'Who are you?', input: roleSelect('elder') }),
    field({
      label: 'Choose a 6-digit passcode',
      hint: 'share it only with people you trust',
      input: h('input', { name: 'passcode', type: 'password', inputmode: 'numeric', autocomplete: 'new-password', required: true, maxlength: '6', pattern: '\\d{6}' }),
    }),
    h('input', { type: 'hidden', name: 'timezone', value: tz }),
    h('p', { class: 'muted' }, `Times will use your time zone: ${tz}.`),
    h('button', { type: 'submit', class: 'big' }, 'Create care circle'),
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    withBusy(form.querySelector('[type=submit]'), async () => {
      try {
        const session = await api('/api/circles', { method: 'POST', body: data });
        app.setSession(session);
        toast(`Care circle created. Your circle code is ${session.circle.code}.`);
        app.navigate('circle');
      } catch (err) {
        showFieldError(form, err);
      }
    });
  });
  return form;
}

export function renderLanding(main, app) {
  const panels = {};
  const tabs = [
    ['join', 'Join a circle'],
    ['create', 'Start a new circle'],
  ];
  const tabButtons = tabs.map(([key, label], i) =>
    h(
      'button',
      {
        type: 'button',
        role: 'tab',
        id: `tab-${key}`,
        'aria-controls': `panel-${key}`,
        'aria-selected': String(i === 0),
        tabindex: i === 0 ? '0' : '-1',
        onclick: () => select(key),
        onkeydown: (e) => {
          if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
            const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length][0];
            select(next);
            document.getElementById(`tab-${next}`).focus();
          }
        },
      },
      label,
    ),
  );
  const select = (key) => {
    for (const [k] of tabs) {
      const btn = document.getElementById(`tab-${k}`);
      btn.setAttribute('aria-selected', String(k === key));
      btn.tabIndex = k === key ? 0 : -1;
      panels[k].hidden = k !== key;
    }
  };

  const formCard = h('section', { class: 'card', 'aria-label': 'Get started' }, h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Get started' }, tabButtons));
  for (const [key] of tabs) {
    panels[key] = h('div', { role: 'tabpanel', id: `panel-${key}`, 'aria-labelledby': `tab-${key}`, hidden: key !== 'join' });
    formCard.append(panels[key]);
  }

  main.append(
    h(
      'div',
      { class: 'hero' },
      h(
        'section',
        {},
        h('h1', {}, 'Care that keeps the elder at the centre.'),
        h('p', { class: 'lead' }, 'SaathiCare is one shared space for an elder, their family and caretakers — medicines, doctor visits and gentle reminders, with the elder in charge.'),
        h(
          'ul',
          { class: 'feature-list' },
          h('li', {}, 'Big, simple "I took it" buttons — or just say it out loud.'),
          h('li', {}, 'Email reminders that escalate: elder first, then caretaker, then family.'),
          h('li', {}, 'Family can suggest changes; the elder approves them.'),
          h('li', {}, 'Snap a prescription and Gemini AI fills in the schedule.'),
          h('li', {}, 'Weekly AI care summaries and doctor-visit question lists.'),
        ),
      ),
      formCard,
    ),
  );

  api('/api/health')
    .then((health) => {
      panels.join.append(joinForm(app, health.demo));
    })
    .catch(() => panels.join.append(joinForm(app, false)));
  panels.create.append(createForm(app));
}
