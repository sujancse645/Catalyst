/**
 * Medicines — list, add/edit, elder approvals, refills, AI explain and prescription scan.
 */
import { api } from '../api.js';
import { confirmDialog, field, fill, fmt, h, nextId, openDialog, toast, withBusy } from '../dom.js';

const LANGS = [
  ['en', 'English'],
  ['hi', 'हिन्दी (Hindi)'],
  ['ta', 'தமிழ் (Tamil)'],
  ['te', 'తెలుగు (Telugu)'],
  ['kn', 'ಕನ್ನಡ (Kannada)'],
  ['bn', 'বাংলা (Bengali)'],
  ['mr', 'मराठी (Marathi)'],
];

/* ---------- add / edit form ---------- */
function timesEditor(initial) {
  const list = h('div', { class: 'stack' });
  const addRow = (value = '') => {
    const input = h('input', { type: 'time', value, required: true, name: 'time' });
    const row = h(
      'div',
      { class: 'row' },
      h('div', { style: 'flex:1' }, field({ label: `Time ${list.children.length + 1}`, input })),
      h('button', { type: 'button', class: 'ghost', 'aria-label': 'Remove this time', onclick: () => list.children.length > 1 && row.remove() }, 'Remove'),
    );
    list.append(row);
    return input;
  };
  (initial.length ? initial : ['08:00']).forEach((t) => addRow(t));
  return {
    node: h(
      'fieldset',
      {},
      h('legend', {}, 'When to take it'),
      list,
      h('button', { type: 'button', class: 'secondary', style: 'margin-top:0.6rem', onclick: () => addRow('').focus() }, '+ Add another time'),
    ),
    values: () => [...list.querySelectorAll('input[type=time]')].map((i) => i.value).filter(Boolean),
  };
}

function medicationForm(app, med, onSaved) {
  const formId = nextId('medform');
  const times = timesEditor(med?.times || []);
  const form = h(
    'form',
    { id: formId, novalidate: true },
    h(
      'div',
      { class: 'grid-2' },
      field({ label: 'Medicine name', input: h('input', { name: 'name', required: true, value: med?.name || '', maxlength: '80' }) }),
      field({ label: 'Dose', hint: 'e.g. 500 mg, 1 tablet', input: h('input', { name: 'dosage', required: true, value: med?.dosage || '', maxlength: '60' }) }),
    ),
    times.node,
    field({ label: 'Instructions', hint: 'optional', input: h('input', { name: 'instructions', value: med?.instructions || '', maxlength: '200', placeholder: 'After food' }) }),
    h(
      'div',
      { class: 'grid-2' },
      field({ label: 'Start date', input: h('input', { name: 'startDate', type: 'date', value: med?.startDate || '' }) }),
      field({ label: 'End date', hint: 'leave empty if ongoing', input: h('input', { name: 'endDate', type: 'date', value: med?.endDate || '' }) }),
    ),
    field({ label: 'Doses in stock', hint: 'optional, for refill alerts', input: h('input', { name: 'pillsLeft', type: 'number', min: '0', max: '10000', inputmode: 'numeric', value: med?.pillsLeft ?? '' }) }),
  );

  const { close } = openDialog({
    title: med ? `Edit ${med.name}` : 'Add a medicine',
    body: form,
    actions: [{ label: med ? 'Save changes' : 'Add medicine', type: 'submit', form: formId }],
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const body = {
      name: fd.get('name'),
      dosage: fd.get('dosage'),
      instructions: fd.get('instructions'),
      times: times.values(),
      endDate: fd.get('endDate') || null,
      pillsLeft: fd.get('pillsLeft') === '' ? null : Number(fd.get('pillsLeft')),
    };
    if (fd.get('startDate')) body.startDate = fd.get('startDate');
    const submit = form.closest('dialog').querySelector('[type=submit]');
    await withBusy(submit, async () => {
      try {
        const res = med
          ? await api(`/api/medications/${med.id}`, { method: 'PATCH', body })
          : await api('/api/medications', { method: 'POST', body });
        toast(res.pendingApproval ? `Sent to ${app.session.circle.elderName} for approval.` : 'Saved.');
        close();
        onSaved();
      } catch (err) {
        toast(err.message, { error: true });
      }
    });
  });
}

/* ---------- AI: explain ---------- */
function explainDialog(med) {
  const select = h('select', { name: 'language' }, LANGS.map(([v, l]) => h('option', { value: v }, l)));
  const out = h('div', { 'aria-live': 'polite' });
  const go = h('button', { type: 'button' }, 'Explain simply');
  go.addEventListener('click', () =>
    withBusy(go, async () => {
      try {
        const r = await api('/api/ai/explain', { method: 'POST', body: { name: med.name, dosage: med.dosage, language: select.value } });
        fill(out, 
          h('h3', {}, 'What it is for'),
          h('p', {}, r.whatItIsFor),
          h('h3', {}, 'How to take it'),
          h('p', {}, r.howToTake),
          r.commonSideEffects.length ? [h('h3', {}, 'Common side effects'), h('ul', {}, r.commonSideEffects.map((x) => h('li', {}, x)))] : null,
          r.askDoctorIf.length ? [h('h3', {}, 'Call the doctor if'), h('ul', {}, r.askDoctorIf.map((x) => h('li', {}, x)))] : null,
          h('p', { class: 'muted' }, r.disclaimer),
        );
      } catch (err) {
        fill(out, h('p', { class: 'field-error' }, err.message));
      }
    }),
  );
  openDialog({
    title: `About ${med.name}`,
    body: h('div', {}, h('p', {}, h('span', { class: 'ai-tag' }, 'Gemini AI'), ' Plain-language explanation in your language.'), field({ label: 'Language', input: select }), go, out),
  });
}

/* ---------- AI: prescription scan ---------- */
async function downscale(file, maxSide = 1600) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  return { mimeType: 'image/jpeg', imageBase64: dataUrl.split(',')[1] };
}

function scanDialog(app, onSaved) {
  const fileInput = h('input', { type: 'file', accept: 'image/*', capture: 'environment', name: 'photo' });
  const out = h('div', { 'aria-live': 'polite' });
  const scanBtn = h('button', { type: 'button' }, 'Read prescription');

  scanBtn.addEventListener('click', () => {
    const file = fileInput.files?.[0];
    if (!file) {
      toast('Please choose a photo first.', { error: true });
      fileInput.focus();
      return;
    }
    withBusy(scanBtn, async () => {
      try {
        const payload = await downscale(file);
        const res = await api('/api/ai/scan-prescription', { method: 'POST', body: payload });
        renderDraft(res);
      } catch (err) {
        fill(out, h('p', { class: 'field-error' }, err.message));
      }
    });
  });

  function renderDraft(res) {
    if (res.medications.length === 0) {
      fill(out, h('p', {}, 'No medicines could be read clearly. Try a sharper photo in good light.'), res.warnings.map((w) => h('p', { class: 'muted' }, w)));
      return;
    }
    const rows = res.medications.map((m) => {
      const cb = h('input', { type: 'checkbox', checked: true, id: nextId('scan') });
      return { m, cb, node: h('li', {}, h('div', { class: 'check' }, cb, h('label', { for: cb.id, style: 'margin:0' }, `${m.name} — ${m.dosage}`)), h('ul', { class: 'times', 'aria-label': 'Times' }, m.times.map((t) => h('li', {}, fmt.time12(t)))), m.instructions ? h('p', { class: 'muted', style: 'margin:0' }, m.instructions) : null) };
    });
    const save = h('button', { type: 'button' }, 'Add selected medicines');
    save.addEventListener('click', () =>
      withBusy(save, async () => {
        const chosen = rows.filter((r) => r.cb.checked);
        let pending = false;
        try {
          for (const { m } of chosen) {
            const endDate = m.durationDays ? new Date(Date.now() + (m.durationDays - 1) * 86400000).toISOString().slice(0, 10) : null;
            const r = await api('/api/medications', { method: 'POST', body: { name: m.name, dosage: m.dosage, times: m.times, instructions: m.instructions, endDate } });
            pending ||= r.pendingApproval;
          }
          toast(`${chosen.length} medicine(s) added${pending ? ` — waiting for ${app.session.circle.elderName}'s approval` : ''}.`);
          document.querySelector('dialog[open]')?.close();
          onSaved();
        } catch (err) {
          toast(err.message, { error: true });
        }
      }),
    );
    fill(out, 
      h('h3', {}, 'Please check what was read'),
      h('ul', { class: 'list' }, rows.map((r) => r.node)),
      res.warnings.map((w) => h('p', { class: 'muted' }, w)),
      save,
    );
  }

  openDialog({
    title: 'Scan a prescription',
    body: h(
      'div',
      {},
      h('p', {}, h('span', { class: 'ai-tag' }, 'Gemini AI'), ' Take a clear photo of the prescription or medicine strip. You will review everything before it is saved.'),
      field({ label: 'Prescription photo', input: fileInput }),
      scanBtn,
      out,
    ),
  });
}

/* ---------- cards ---------- */
function proposalText(med) {
  const p = med.proposal;
  if (med.status === 'pending') return `New medicine suggested by ${med.createdByName}.`;
  if (p.type === 'delete') return `${p.byName} suggests stopping this medicine.`;
  const parts = Object.entries(p.changes).map(([k, v]) => `${k} → ${Array.isArray(v) ? v.map(fmt.time12).join(', ') : v ?? 'none'}`);
  return `${p.byName} suggests: ${parts.join('; ')}.`;
}

function medCard(med, app, reload) {
  const isElder = app.session.member.role === 'elder';
  const awaiting = med.status === 'pending' || med.proposal;
  const headingId = nextId('med');

  const review = (decision) => async (e) =>
    withBusy(e.currentTarget, async () => {
      try {
        await api(`/api/medications/${med.id}/review`, { method: 'POST', body: { decision } });
        toast(decision === 'approve' ? 'Approved.' : 'Declined.');
        reload();
      } catch (err) {
        toast(err.message, { error: true });
      }
    });

  const remove = async () => {
    if (!(await confirmDialog(`Stop ${med.name}?`, 'It will be removed from the schedule.', 'Stop medicine', true))) return;
    try {
      const r = await api(`/api/medications/${med.id}`, { method: 'DELETE' });
      toast(r.pendingApproval ? `Sent to ${app.session.circle.elderName} for approval.` : `${med.name} removed.`);
      reload();
    } catch (err) {
      toast(err.message, { error: true });
    }
  };

  const refill = () => {
    const formId = nextId('refill');
    const input = h('input', { type: 'number', min: '0', max: '10000', name: 'pillsLeft', required: true, value: med.pillsLeft ?? 30, inputmode: 'numeric' });
    const form = h('form', { id: formId }, field({ label: 'Doses now in stock', input }));
    const { close } = openDialog({ title: `Refill ${med.name}`, body: form, actions: [{ label: 'Save', type: 'submit', form: formId }] });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api(`/api/medications/${med.id}/refill`, { method: 'POST', body: { pillsLeft: Number(input.value) } });
        toast('Stock updated.');
        close();
        reload();
      } catch (err) {
        toast(err.message, { error: true });
      }
    });
  };

  return h(
    'li',
    { class: 'card', 'aria-labelledby': headingId },
    h('h3', { id: headingId }, med.name, ' ', h('span', { class: 'muted', style: 'font-weight:600' }, med.dosage)),
    h('ul', { class: 'times', 'aria-label': 'Times' }, med.times.map((t) => h('li', {}, fmt.time12(t)))),
    med.instructions ? h('p', { style: 'margin:0' }, med.instructions) : null,
    h(
      'p',
      { class: 'muted', style: 'margin:0.3rem 0' },
      med.endDate ? `Until ${med.endDate}` : 'Ongoing',
      med.stock ? ' · ' : '',
      med.stock ? h('span', { class: med.stock.low ? 'badge due' : '' }, `${med.stock.pillsLeft} doses left (~${med.stock.daysLeft} days)`) : null,
    ),
    awaiting
      ? h(
          'div',
          { class: 'banner warn', style: 'margin:0.6rem 0' },
          h('p', { style: 'margin:0' }, h('span', { class: 'badge pending' }, 'Needs approval'), ' ', proposalText(med)),
          isElder
            ? h('div', { class: 'row' }, h('button', { type: 'button', onclick: review('approve') }, 'Approve'), h('button', { type: 'button', class: 'danger', onclick: review('reject') }, 'Decline'))
            : h('p', { class: 'muted', style: 'margin:0' }, `Waiting for ${app.session.circle.elderName}.`),
        )
      : null,
    med.status === 'active'
      ? h(
          'div',
          { class: 'row', style: 'margin-top:0.6rem' },
          h('button', { type: 'button', class: 'secondary', onclick: () => medicationForm(app, med, reload), 'aria-describedby': headingId }, 'Edit'),
          h('button', { type: 'button', class: 'secondary', onclick: refill, 'aria-describedby': headingId }, 'Refill'),
          h('button', { type: 'button', class: 'secondary', onclick: () => explainDialog(med), 'aria-describedby': headingId }, 'Explain'),
          h('button', { type: 'button', class: 'danger', onclick: remove, 'aria-describedby': headingId }, 'Stop'),
        )
      : null,
  );
}

export async function renderMedications(app) {
  const { items } = await api('/api/medications');
  const reload = () => app.render();
  const pending = items.filter((m) => m.status === 'pending' || m.proposal);
  const active = items.filter((m) => m.status === 'active' && !m.proposal);
  const isElder = app.session.member.role === 'elder';

  return h(
    'div',
    {},
    h('h1', {}, 'Medicines'),
    h('p', { class: 'lead' }, isElder ? 'Your medicines. Changes suggested by family wait for your approval.' : `${app.session.circle.elderName}'s medicines. Your changes are sent to them for approval.`),
    h(
      'div',
      { class: 'row', style: 'margin-bottom:1.25rem' },
      h('button', { type: 'button', class: 'big', onclick: () => medicationForm(app, null, reload) }, '+ Add medicine'),
      h('button', { type: 'button', class: 'big secondary', onclick: () => scanDialog(app, reload) }, h('span', { 'aria-hidden': 'true' }, '📷'), 'Scan prescription'),
    ),
    pending.length
      ? h('section', { 'aria-labelledby': 'pending-h' }, h('h2', { id: 'pending-h' }, `Waiting for approval (${pending.length})`), h('ul', { class: 'cards', style: 'list-style:none;padding:0' }, pending.map((m) => medCard(m, app, reload))))
      : null,
    h(
      'section',
      { 'aria-labelledby': 'active-h' },
      h('h2', { id: 'active-h' }, `Current medicines (${active.length})`),
      active.length
        ? h('ul', { class: 'cards', style: 'list-style:none;padding:0' }, active.map((m) => medCard(m, app, reload)))
        : h('p', { class: 'card empty' }, 'No medicines yet. Add one or scan a prescription.'),
    ),
  );
}
