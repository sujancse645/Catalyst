/**
 * Insights — 7-day adherence chart (with accessible table) and AI weekly digest.
 */
import { api } from '../api.js';
import { fill, h, withBusy } from '../dom.js';

const dayLabel = (date) =>
  new Intl.DateTimeFormat('en-IN', { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));

function chart(adherence) {
  const bars = adherence.byDay.map((d) => {
    const pct = d.scheduled ? Math.round((d.taken / d.scheduled) * 100) : 0;
    const bar = h('div', { class: `bar${d.scheduled ? '' : ' empty'}`, 'aria-hidden': 'true' });
    bar.style.height = `${Math.max(pct, 3)}%`;
    return bar;
  });
  return h(
    'figure',
    { style: 'margin:0' },
    h('div', { class: 'bars' }, bars),
    h('div', { class: 'bar-labels', 'aria-hidden': 'true' }, adherence.byDay.map((d) => h('span', {}, dayLabel(d.date)))),
    h('figcaption', { class: 'sr-only' }, 'Doses taken per day for the last 7 days. Details in the table below.'),
    h(
      'details',
      { style: 'margin-top:0.75rem' },
      h('summary', {}, 'Show as a table'),
      h(
        'table',
        {},
        h('caption', { class: 'sr-only' }, 'Doses taken per day'),
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Day'), h('th', { scope: 'col' }, 'Taken'), h('th', { scope: 'col' }, 'Due'))),
        h('tbody', {}, adherence.byDay.map((d) => h('tr', {}, h('th', { scope: 'row' }, `${dayLabel(d.date)} ${d.date}`), h('td', {}, d.taken), h('td', {}, d.scheduled)))),
      ),
    ),
  );
}

function digestView(d) {
  const list = (title, items) => (items.length ? [h('h3', {}, title), h('ul', {}, items.map((i) => h('li', {}, i)))] : null);
  return h(
    'div',
    { class: 'stack' },
    h('p', {}, d.source === 'gemini' ? h('span', { class: 'ai-tag' }, 'Written by Gemini AI') : h('span', { class: 'badge neutral' }, 'Basic summary (AI unavailable)')),
    h('p', { style: 'font-size:1.1rem' }, d.summary),
    list('Going well', d.highlights),
    list('Worth watching', d.concerns),
    list('Ideas to help', d.suggestions),
  );
}

export async function renderInsights(app) {
  const { adherence } = await api('/api/today');
  const out = h('div', { 'aria-live': 'polite' });
  const btn = h('button', { type: 'button', class: 'big' }, 'Write this week’s care summary');
  btn.addEventListener('click', () =>
    withBusy(btn, async () => {
      try {
        fill(out, digestView(await api('/api/ai/digest')));
      } catch (err) {
        fill(out, h('p', { class: 'field-error' }, err.message));
      }
    }),
  );

  return h(
    'div',
    {},
    h('h1', {}, 'Insights'),
    h('p', { class: 'lead' }, `How ${app.session.circle.elderName}'s week is going. A summary is also emailed to the family every Sunday.`),
    h(
      'div',
      { class: 'stats' },
      h('div', { class: 'stat' }, h('span', { class: 'value' }, adherence.percent === null ? '—' : `${adherence.percent}%`), h('span', { class: 'label' }, 'doses taken (7 days)')),
      h('div', { class: 'stat' }, h('span', { class: 'value' }, String(adherence.taken)), h('span', { class: 'label' }, 'doses taken')),
      h('div', { class: 'stat' }, h('span', { class: 'value' }, String(adherence.missed)), h('span', { class: 'label' }, 'doses missed')),
      h('div', { class: 'stat' }, h('span', { class: 'value' }, `${adherence.streak}`), h('span', { class: 'label' }, 'day streak')),
    ),
    h('section', { class: 'card', 'aria-labelledby': 'chart-h' }, h('h2', { id: 'chart-h', style: 'margin-top:0' }, 'Last 7 days'), chart(adherence)),
    h('section', { class: 'card', style: 'margin-top:1rem', 'aria-labelledby': 'digest-h' }, h('h2', { id: 'digest-h', style: 'margin-top:0' }, 'Weekly care summary'), btn, out),
  );
}
