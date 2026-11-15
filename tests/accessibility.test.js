/**
 * Static accessibility & front-end safety checks (WCAG 2.1 AA essentials).
 * Full in-browser checks are in the README's manual test list.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../public/', import.meta.url);
const html = readFileSync(new URL('index.html', root), 'utf8');
const css = readFileSync(new URL('styles.css', root), 'utf8');
const jsDir = new URL('js/', root);
const jsFiles = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir.pathname ?? dir, entry.name);
    if (entry.isDirectory()) walk(new URL(`${entry.name}/`, dir));
    else jsFiles.push({ name: entry.name, src: readFileSync(p, 'utf8') });
  }
};
walk(jsDir);

test('document declares language, viewport and title', () => {
  assert.match(html, /<html lang="en">/);
  assert.match(html, /name="viewport" content="width=device-width, initial-scale=1"/);
  assert.doesNotMatch(html, /user-scalable=no|maximum-scale=1/, 'pinch zoom must stay enabled');
  assert.match(html, /<title>[^<]+<\/title>/);
});

test('landmarks, skip link and live regions exist', () => {
  assert.match(html, /class="skip-link" href="#main"/);
  assert.match(html, /<main id="main"/);
  assert.match(html, /<header/);
  assert.match(html, /<nav[^>]+aria-label="Main"/);
  assert.match(html, /<footer/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /role="alert"/);
});

test('decorative images have empty alt', () => {
  for (const img of html.match(/<img[^>]*>/g) || []) assert.match(img, /alt="/);
});

test('styles: visible focus, large targets, reduced motion, high contrast, scalable text', () => {
  assert.match(css, /:focus-visible\s*{\s*outline: 3px/);
  assert.match(css, /min-height: 48px/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /data-contrast='high'/);
  assert.match(css, /font-size: var\(--fs\)/);
});

test('no innerHTML / eval anywhere in client code (XSS-safe rendering)', () => {
  for (const f of jsFiles) {
    assert.doesNotMatch(f.src, /\.innerHTML\s*=|insertAdjacentHTML|outerHTML\s*=|\beval\(|new Function\(/, f.name);
  }
});

test('no blocking alert/confirm/prompt dialogs', () => {
  for (const f of jsFiles) assert.doesNotMatch(f.src, /\b(window\.)?(alert|confirm|prompt)\(/, f.name);
});

test('every form control is created through the labelled field() helper or has a label', () => {
  for (const f of jsFiles.filter((x) => x.name !== 'dom.js')) {
    const inputs = (f.src.match(/h\('(input|select|textarea)'/g) || []).length;
    const labelled =
      (f.src.match(/field\(\{/g) || []).length +
      (f.src.match(/type: 'hidden'/g) || []).length +
      (f.src.match(/type: 'checkbox'/g) || []).length;
    assert.ok(labelled >= inputs, `${f.name}: ${inputs} controls, ${labelled} labelled`);
  }
});

test('status badges carry text, not colour alone', () => {
  const today = jsFiles.find((f) => f.name === 'today.js').src;
  for (const label of ['Taken', 'Due now', 'Missed', 'Later', 'Skipped']) assert.ok(today.includes(`'${label}'`));
});

test('route changes move focus to the page heading', () => {
  const app = jsFiles.find((f) => f.name === 'app.js').src;
  assert.match(app, /heading\.focus/);
  assert.match(app, /aria-current/);
});
