/**
 * Appointments — upcoming visits with countdown and AI doctor-visit preparation.
 */
import { api } from '../api.js';
import { confirmDialog, field, fill, fmt, h, nextId, openDialog, toLocalInput, toast } from '../dom.js';

function appointmentForm(appt, onSaved) {
  const formId = nextId('appt');
  const form = h(
    'form',
    { id: formId, novalidate: true },
    h(
      'div',
      { class: 'grid-2' },
      field({ label: 'Doctor', input: h('input', { name: 'doctor', required: true, value: appt?.doctor || '', maxlength: '80', placeholder: 'Dr. Rao' }) }),
      field({ label: 'Speciality', hint: 'optional', input: h('input', { name: 'specialty', value: appt?.specialty || '', maxlength: '60' }) }),
    ),
    field({ label: 'Date and time', input: h('input', { name: 'datetime', type: 'datetime-local', required: true, value: appt ? toLocalInput(appt.datetime) : '' }) }),
    field({ label: 'Place', hint: 'optional', input: h('input', { name: 'location', value: appt?.location || '', maxlength: '160' }) }),
    field({ label: 'Notes', hint: 'optional', input: h('textarea', { name: 'notes', maxlength: '500' }, appt?.notes || '') }),
  );
  const { close } = openDialog({
    title: appt ? 'Edit appointment' : 'Add appointment',
    body: form,
    actions: [{ label: 'Save', type: 'submit', form: formId }],
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const local = fd.get('datetime');
    if (!local) {
      toast('Please choose a date and time.', { error: true });
      return;
    }
    const body = {
      doctor: fd.get('doctor'),
      specialty: fd.get('specialty'),
      datetime: new Date(local).toISOString(),
      location: fd.get('location'),
      notes: fd.get('notes'),
    };
    try {
      if (appt) await api(`/api/appointments/${appt.id}`, { method: 'PATCH', body });
      else await api('/api/appointments', { method: 'POST', body });
      toast('Appointment saved. Everyone will get email reminders 24 hours and 2 hours before.');
      close();
      onSaved();
    } catch (err) {
      toast(err.message, { error: true });
    }
  });
}

function prepDialog(appt, tz) {
  const out = h('div', { 'aria-live': 'polite' }, h('p', { class: 'loading' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), ' Preparing your questions…'));
  openDialog({
    title: `Prepare for ${appt.doctor}`,
    body: h('div', {}, h('p', { class: 'muted' }, fmt.dateTime(appt.datetime, tz)), out),
    actions: [{ label: 'Print', onClick: () => window.print() }],
  });
  api(`/api/ai/doctor-prep/${appt.id}`)
    .then((r) =>
      fill(out, 
        h('p', {}, r.source === 'gemini' ? h('span', { class: 'ai-tag' }, 'Gemini AI') : h('span', { class: 'badge neutral' }, 'Basic summary')),
        h('h3', {}, 'Summary for the doctor'),
        h('p', {}, r.summary),
        h('h3', {}, 'Questions to ask'),
        h('ol', {}, r.questions.map((q) => h('li', {}, q))),
        r.bring.length ? [h('h3', {}, 'Bring with you'), h('ul', {}, r.bring.map((b) => h('li', {}, b)))] : null,
        h('p', { class: 'muted' }, r.disclaimer),
      ),
    )
    .catch((err) => fill(out, h('p', { class: 'field-error' }, err.message)));
}

function apptCard(appt, tz, reload, upcoming) {
  const headingId = nextId('ap');
  const remove = async () => {
    if (!(await confirmDialog('Remove appointment?', `${appt.doctor} on ${fmt.dateTime(appt.datetime, tz)}`, 'Remove', true))) return;
    try {
      await api(`/api/appointments/${appt.id}`, { method: 'DELETE' });
      toast('Appointment removed.');
      reload();
    } catch (err) {
      toast(err.message, { error: true });
    }
  };
  return h(
    'li',
    { class: 'card', 'aria-labelledby': headingId },
    h('h3', { id: headingId }, appt.doctor, appt.specialty ? h('span', { class: 'muted', style: 'font-weight:600' }, ` · ${appt.specialty}`) : null),
    h('p', { style: 'margin:0', class: 'appt-when' }, h('strong', {}, fmt.dateTime(appt.datetime, tz)), upcoming ? h('span', { class: 'muted' }, ` (${fmt.relative(appt.datetime)})`) : null),
    appt.location ? h('p', { style: 'margin:0' }, appt.location) : null,
    appt.notes ? h('p', { class: 'muted', style: 'margin:0.3rem 0 0' }, appt.notes) : null,
    upcoming
      ? h(
          'div',
          { class: 'row', style: 'margin-top:0.75rem' },
          h('button', { type: 'button', onclick: () => prepDialog(appt, tz), 'aria-describedby': headingId }, 'Prepare questions'),
          h('button', { type: 'button', class: 'secondary', onclick: () => appointmentForm(appt, reload), 'aria-describedby': headingId }, 'Edit'),
          h('button', { type: 'button', class: 'danger', onclick: remove, 'aria-describedby': headingId }, 'Remove'),
        )
      : null,
  );
}

export async function renderAppointments(app) {
  const { upcoming, past } = await api('/api/appointments');
  const tz = app.session.circle.timezone;
  const reload = () => app.render();
  return h(
    'div',
    {},
    h('h1', {}, 'Appointments'),
    h('p', { class: 'lead' }, 'Everyone in the circle gets an email 24 hours and 2 hours before each visit.'),
    h('button', { type: 'button', class: 'big', onclick: () => appointmentForm(null, reload) }, '+ Add appointment'),
    h(
      'section',
      { 'aria-labelledby': 'up-h' },
      h('h2', { id: 'up-h' }, `Upcoming (${upcoming.length})`),
      upcoming.length
        ? h('ul', { class: 'cards', style: 'list-style:none;padding:0' }, upcoming.map((a) => apptCard(a, tz, reload, true)))
        : h('p', { class: 'card empty' }, 'No upcoming appointments.'),
    ),
    past.length
      ? h('section', { 'aria-labelledby': 'past-h' }, h('h2', { id: 'past-h' }, 'Past visits'), h('ul', { class: 'cards', style: 'list-style:none;padding:0' }, past.map((a) => apptCard(a, tz, reload, false))))
      : null,
  );
}
