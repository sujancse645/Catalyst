/**
 * Care circle — invite people, roles, elder controls, email log and activity trail.
 */
import { api } from '../api.js';
import { confirmDialog, field, fmt, h, nextId, openDialog, toast, withBusy } from '../dom.js';

const ROLE_LABEL = { elder: 'Elder', caretaker: 'Caretaker', family: 'Family' };

const ACTION_LABEL = {
  'circle.created': 'Created the circle',
  'member.joined': 'Joined',
  'member.removed': 'Removed a member',
  'circle.passcode_changed': 'Changed the passcode',
  'circle.settings': 'Changed settings',
  'medication.added': 'Added medicine',
  'medication.proposed': 'Suggested a medicine',
  'medication.updated': 'Updated medicine',
  'medication.change_proposed': 'Suggested a change',
  'medication.removal_proposed': 'Suggested stopping',
  'medication.approved': 'Approved medicine',
  'medication.rejected': 'Declined medicine',
  'medication.change_approved': 'Approved a change',
  'medication.change_rejected': 'Declined a change',
  'medication.removal_approved': 'Approved stopping',
  'medication.removed': 'Stopped medicine',
  'medication.refilled': 'Refilled',
  'dose.taken': 'Took a dose',
  'dose.skipped': 'Skipped a dose',
  'dose.undone': 'Undid a check-in',
  'appointment.added': 'Added appointment',
  'appointment.updated': 'Updated appointment',
  'appointment.removed': 'Removed appointment',
  'ai.prescription_scanned': 'Scanned a prescription',
};

function passcodeDialog(app) {
  const formId = nextId('pc');
  const form = h(
    'form',
    { id: formId },
    field({ label: 'Current passcode', input: h('input', { name: 'currentPasscode', type: 'password', inputmode: 'numeric', maxlength: '6', required: true, autocomplete: 'current-password' }) }),
    field({ label: 'New 6-digit passcode', input: h('input', { name: 'newPasscode', type: 'password', inputmode: 'numeric', maxlength: '6', required: true, autocomplete: 'new-password' }) }),
    h('p', { class: 'muted' }, 'Everyone else will be signed out and must use the new passcode.'),
  );
  const { close } = openDialog({ title: 'Change passcode', body: form, actions: [{ label: 'Change passcode', type: 'submit', form: formId }] });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/circle/passcode', { method: 'POST', body: Object.fromEntries(new FormData(form)) });
      toast('Passcode changed. Share the new one with your family.');
      close();
      app.render();
    } catch (err) {
      toast(err.message, { error: true });
    }
  });
}

export async function renderCircle(app) {
  const [{ circle, members, emailMode, aiAvailable }, audit, outbox] = await Promise.all([
    api('/api/circle'),
    api('/api/audit?limit=30'),
    api('/api/outbox?limit=20'),
  ]);
  const me = app.session.member;
  const isElder = me.role === 'elder';
  const tz = circle.timezone;

  const copyBtn = h('button', { type: 'button', class: 'secondary' }, 'Copy invite message');
  copyBtn.addEventListener('click', async () => {
    const text = `Join ${circle.elderName}'s care circle on SaathiCare: ${location.origin} — circle code ${circle.code}. I'll share the passcode with you separately.`;
    try {
      await navigator.clipboard.writeText(text);
      toast('Invite message copied.');
    } catch {
      toast(text);
    }
  });

  const approvalToggle = h('input', { type: 'checkbox', id: 'approval-toggle', checked: circle.settings.requireElderApproval, disabled: !isElder });
  approvalToggle.addEventListener('change', async () => {
    try {
      await api('/api/circle/settings', { method: 'PATCH', body: { requireElderApproval: approvalToggle.checked } });
      toast(approvalToggle.checked ? 'Family changes now need your approval.' : 'Family changes now apply straight away.');
    } catch (err) {
      approvalToggle.checked = !approvalToggle.checked;
      toast(err.message, { error: true });
    }
  });

  const removeMember = (m) => async (e) => {
    if (!(await confirmDialog(`Remove ${m.name}?`, 'They will lose access immediately.', 'Remove', true))) return;
    await withBusy(e.target, async () => {
      try {
        await api(`/api/members/${m.id}`, { method: 'DELETE' });
        toast(`${m.name} removed.`);
        app.render();
      } catch (err) {
        toast(err.message, { error: true });
      }
    });
  };

  return h(
    'div',
    {},
    h('h1', {}, `${circle.elderName}'s care circle`),
    h('p', { class: 'lead' }, `You are signed in as ${me.name} (${ROLE_LABEL[me.role]}).`),

    h(
      'section',
      { class: 'card', 'aria-labelledby': 'invite-h' },
      h('h2', { id: 'invite-h', style: 'margin-top:0' }, 'Invite family and caretakers'),
      h('p', {}, 'Circle code: ', h('span', { class: 'code' }, circle.code)),
      h('p', { class: 'muted' }, 'Share the code and the 6-digit passcode only with people you trust.'),
      h('div', { class: 'row' }, copyBtn, isElder ? h('button', { type: 'button', class: 'secondary', onclick: () => passcodeDialog(app) }, 'Change passcode') : null),
    ),

    h(
      'section',
      { 'aria-labelledby': 'members-h' },
      h('h2', { id: 'members-h' }, `People (${members.length})`),
      h(
        'ul',
        { class: 'card list' },
        members.map((m) =>
          h(
            'li',
            { class: 'row', style: 'justify-content:space-between' },
            h('div', {}, h('strong', {}, m.name), ' ', h('span', { class: 'badge neutral' }, ROLE_LABEL[m.role]), h('div', { class: 'muted' }, m.email)),
            isElder && m.id !== me.id ? h('button', { type: 'button', class: 'danger', onclick: removeMember(m) }, `Remove ${m.name.split(' ')[0]}`) : null,
          ),
        ),
      ),
    ),

    h(
      'section',
      { class: 'card', style: 'margin-top:1rem', 'aria-labelledby': 'settings-h' },
      h('h2', { id: 'settings-h', style: 'margin-top:0' }, 'Elder in charge'),
      h('div', { class: 'check' }, approvalToggle, h('label', { for: 'approval-toggle', style: 'margin:0' }, 'Medicine changes by others need the elder’s approval')),
      !isElder ? h('p', { class: 'muted' }, 'Only the elder can change this.') : null,
      h('p', { class: 'muted' }, `Email reminders: ${emailMode === 'smtp' ? 'sending by email' : 'demo mode (logged below, not sent)'} · AI assistant: ${aiAvailable ? 'on' : 'off'}`),
    ),

    h(
      'section',
      { 'aria-labelledby': 'outbox-h' },
      h('h2', { id: 'outbox-h' }, 'Reminder emails'),
      outbox.items.length
        ? h(
            'ul',
            { class: 'card list' },
            outbox.items.map((m) =>
              h(
                'li',
                {},
                h('strong', {}, m.subject),
                h('div', { class: 'muted' }, `${fmt.dateTime(m.createdAt, tz)} · to ${m.to.join(', ')} · ${m.status}`),
                h('div', {}, m.preview),
              ),
            ),
          )
        : h('p', { class: 'card empty' }, 'No reminder emails yet. They are sent automatically when doses are due or missed.'),
    ),

    h(
      'section',
      { 'aria-labelledby': 'audit-h' },
      h('h2', { id: 'audit-h' }, 'Recent activity'),
      h(
        'ul',
        { class: 'card list' },
        audit.items.map((a) =>
          h('li', {}, h('strong', {}, `${a.actorName}: `), ACTION_LABEL[a.action] || a.action, a.detail ? ` — ${a.detail}` : '', h('div', { class: 'muted' }, fmt.dateTime(a.at, tz))),
        ),
      ),
    ),

    h('div', { style: 'margin-top:1.5rem' }, h('button', { type: 'button', class: 'secondary', onclick: () => app.signOut() }, 'Sign out on this device')),
  );
}
