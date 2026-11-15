/**
 * Email delivery with zero dependencies.
 *  - createSmtpTransport: minimal SMTP client over implicit TLS (port 465),
 *    works with Gmail SMTP + an App Password, or any SMTP relay.
 *  - createMailer: wraps a transport, records every message in the `outbox`
 *    collection (audit trail + visible "Email log" in the UI). With no SMTP
 *    configured it runs in demo mode: messages are logged, not sent.
 */
import { connect } from 'node:tls';
import { newId } from './security.js';

/** Remove CR/LF so user data can never inject extra email headers. */
export const sanitizeHeader = (value) => String(value ?? '').replace(/[\r\n]+/g, ' ').trim();

const encodeWord = (text) => `=?UTF-8?B?${Buffer.from(sanitizeHeader(text)).toString('base64')}?=`;
const b64Lines = (text) =>
  Buffer.from(text, 'utf8')
    .toString('base64')
    .replace(/.{1,76}/g, '$&\r\n');

/** Build an RFC 5322 multipart/alternative message. */
export function buildMessage({ from, to, subject, text, html, date = new Date() }) {
  const boundary = `sc_${newId()}`;
  const recipients = (Array.isArray(to) ? to : [to]).map(sanitizeHeader).join(', ');
  return [
    `From: ${sanitizeHeader(from)}`,
    `To: ${recipients}`,
    `Subject: ${encodeWord(subject)}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${newId()}@saathicare>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64Lines(text),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64Lines(html || text),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

/** Extract the bare address from `Name <addr@x>` or `addr@x`. */
export const bareAddress = (value) => {
  const m = /<([^>]+)>/.exec(value);
  return sanitizeHeader(m ? m[1] : value);
};

export function createSmtpTransport({ host, port = 465, user, pass, timeoutMs = 15_000, connectImpl = connect }) {
  return {
    async send({ from, to, raw }) {
      const socket = connectImpl({ host, port, servername: host });
      socket.setEncoding('utf8');
      socket.setTimeout(timeoutMs, () => socket.destroy(new Error('SMTP timeout')));

      let buffer = '';
      const waiters = [];
      socket.on('data', (chunk) => {
        buffer += chunk;
        // A complete reply ends with a line "NNN text" (space after code, not dash).
        const lines = buffer.split('\r\n');
        for (let i = 0; i < lines.length - 1; i += 1) {
          if (/^\d{3} /.test(lines[i])) {
            const reply = lines.slice(0, i + 1).join('\n');
            buffer = lines.slice(i + 1).join('\r\n');
            waiters.shift()?.resolve(reply);
            return;
          }
        }
      });
      socket.on('error', (err) => waiters.splice(0).forEach((w) => w.reject(err)));

      const read = () => new Promise((resolve, reject) => waiters.push({ resolve, reject }));
      const expect = async (code) => {
        const reply = await read();
        if (!reply.startsWith(String(code))) throw new Error(`SMTP expected ${code}, got: ${reply.slice(0, 120)}`);
        return reply;
      };
      const cmd = async (line, code) => {
        const p = expect(code);
        socket.write(`${line}\r\n`);
        return p;
      };

      try {
        await expect(220);
        await cmd('EHLO saathicare', 250);
        if (user) {
          await cmd('AUTH LOGIN', 334);
          await cmd(Buffer.from(user).toString('base64'), 334);
          await cmd(Buffer.from(pass).toString('base64'), 235);
        }
        await cmd(`MAIL FROM:<${bareAddress(from)}>`, 250);
        for (const rcpt of to) await cmd(`RCPT TO:<${bareAddress(rcpt)}>`, 250);
        await cmd('DATA', 354);
        // Dot-stuffing: lines beginning with "." must be doubled.
        await cmd(`${raw.replace(/\r\n\./g, '\r\n..')}\r\n.`, 250);
        socket.write('QUIT\r\n');
      } finally {
        socket.end();
      }
    },
  };
}

export function createMailer({ transport, store, from, logger }) {
  return {
    mode: transport ? 'smtp' : 'demo',
    /**
     * @param {{to: string[], subject: string, text: string, html?: string, kind: string, circleId: string}} msg
     */
    async send(msg) {
      const to = [...new Set(msg.to.filter(Boolean))];
      if (to.length === 0) return { status: 'skipped' };
      const record = {
        circleId: msg.circleId,
        kind: msg.kind,
        to,
        subject: sanitizeHeader(msg.subject),
        preview: msg.text.slice(0, 280),
        createdAt: new Date().toISOString(),
        status: 'logged',
      };
      if (transport) {
        try {
          await transport.send({ from, to, raw: buildMessage({ from, to, ...msg }) });
          record.status = 'sent';
        } catch (err) {
          record.status = 'failed';
          record.error = err.message.slice(0, 200);
          logger?.error('email send failed', { kind: msg.kind, error: err.message });
        }
      }
      await store.set('outbox', newId(), record);
      return { status: record.status };
    },
  };
}
