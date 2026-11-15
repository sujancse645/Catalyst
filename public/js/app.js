/**
 * SaathiCare client: session state, hash router, display preferences.
 */
import { api, setUnauthorizedHandler } from './api.js';
import { clear, h, toast } from './dom.js';
import { renderLanding } from './views/landing.js';
import { renderToday } from './views/today.js';
import { renderMedications } from './views/medications.js';
import { renderAppointments } from './views/appointments.js';
import { renderInsights } from './views/insights.js';
import { renderCircle } from './views/circle.js';

const ROUTES = {
  today: { title: 'Today', render: renderToday },
  medications: { title: 'Medicines', render: renderMedications },
  appointments: { title: 'Appointments', render: renderAppointments },
  insights: { title: 'Insights', render: renderInsights },
  circle: { title: 'Care circle', render: renderCircle },
};

const main = document.getElementById('main');
const nav = document.getElementById('main-nav');

export const app = {
  session: null,
  navigate(route) {
    if (location.hash === `#/${route}`) render();
    else location.hash = `#/${route}`;
  },
  setSession(session) {
    app.session = session;
    nav.hidden = !session;
  },
  async signOut() {
    await api('/api/session', { method: 'DELETE' }).catch(() => {});
    app.setSession(null);
    location.hash = '#/';
    render();
  },
};

/* ---------- display preferences (persisted per device) ---------- */
const TEXT_SIZES = [
  { key: 'normal', label: 'Normal' },
  { key: 'large', label: 'Large' },
  { key: 'xlarge', label: 'Extra large' },
];

const prefs = {
  read(key, fallback) {
    try {
      return localStorage.getItem(`sc.${key}`) ?? fallback;
    } catch {
      return fallback;
    }
  },
  write(key, value) {
    try {
      localStorage.setItem(`sc.${key}`, value);
    } catch {
      /* storage unavailable (private mode) — preference lasts for this visit */
    }
  },
};

function applyPrefs() {
  const size = prefs.read('text', 'normal');
  const contrast = prefs.read('contrast', 'normal');
  document.documentElement.dataset.text = size;
  document.documentElement.dataset.contrast = contrast;
  const sizeBtn = document.getElementById('text-size');
  const label = TEXT_SIZES.find((s) => s.key === size)?.label || 'Normal';
  sizeBtn.replaceChildren(`Text size: ${label}`);
  const contrastBtn = document.getElementById('contrast');
  contrastBtn.setAttribute('aria-pressed', String(contrast === 'high'));
}

document.getElementById('text-size').addEventListener('click', () => {
  const current = TEXT_SIZES.findIndex((s) => s.key === prefs.read('text', 'normal'));
  const next = TEXT_SIZES[(current + 1) % TEXT_SIZES.length];
  prefs.write('text', next.key);
  applyPrefs();
  toast(`Text size: ${next.label}`);
});
document.getElementById('contrast').addEventListener('click', () => {
  const next = prefs.read('contrast', 'normal') === 'high' ? 'normal' : 'high';
  prefs.write('contrast', next);
  applyPrefs();
  toast(next === 'high' ? 'High contrast on' : 'High contrast off');
});

/* ---------- router ---------- */
let renderToken = 0;

async function render() {
  const token = (renderToken += 1);
  const route = location.hash.replace(/^#\/?/, '').split('?')[0] || 'today';

  if (!app.session) {
    document.title = 'SaathiCare — care circle for elders and families';
    clear(main);
    renderLanding(main, app);
    focusHeading();
    return;
  }

  const def = ROUTES[route] || ROUTES.today;
  document.title = `${def.title} · SaathiCare`;
  for (const link of nav.querySelectorAll('a')) {
    if (link.dataset.route === route) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  clear(main).append(h('p', { class: 'loading' }, 'Loading…'));
  try {
    const view = await def.render(app);
    if (token !== renderToken) return; // a newer navigation won
    clear(main).append(view);
    focusHeading();
  } catch (err) {
    if (token !== renderToken) return;
    clear(main).append(
      h('h1', { tabindex: '-1' }, 'Something went wrong'),
      h('p', {}, err.message),
      h('button', { type: 'button', onclick: render }, 'Try again'),
    );
  }
}
app.render = render;

function focusHeading() {
  const heading = main.querySelector('h1');
  if (heading) {
    heading.setAttribute('tabindex', '-1');
    heading.focus({ preventScroll: false });
  }
}

setUnauthorizedHandler(() => {
  if (!app.session) return;
  app.setSession(null);
  toast('Your session has ended. Please join again.', { error: true });
  render();
});

window.addEventListener('hashchange', render);

applyPrefs();
api('/api/session')
  .then((s) => app.setSession(s.member ? s : null))
  .catch(() => app.setSession(null))
  .finally(render);
