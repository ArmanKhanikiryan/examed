// Layout checks by measured numbers on every screen and five viewports: a stretched, clipped,
// overlapping or untranslated screen fails here. Each failure names route, viewport, element and
// the measured value. Routes run in order, as one learner would reach them: a new screen is one line.
import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { hy } from '../src/i18n/hy';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';

const status = JSON.parse(execSync('npx supabase status -o json').toString().replace(/^[^{]*/, ''));
const admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY, { auth: { persistSession: false } });
// each language falls back to en like the app does; the app reads its language from storage key 'lang'
const TABLES = { hy: { ...en, ...hy }, en, ru: { ...en, ...ru } } as Record<'hy' | 'en' | 'ru', typeof en>;
const LANGS = ['hy', 'en', 'ru'] as const;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PASS = 'e2e-pass-12345';
const VIEWPORTS = [[390, 844], [768, 1024], [1024, 768], [1440, 900], [1920, 1080], [2560, 1440]] as const;
const DESKTOP = 1024;
const SIDEBAR_FROM = 1024; // medprep-ui plans the sidebar from 768 (docs/design/desktop.md); change here when it lands

/** Answer the question on screen with its first option and check it. */
/** Network quiet (capped: a poll may keep it busy) and the screen's heading drawn. */
async function loaded(page: Page) {
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  await expect(page.getByRole('heading').first()).toBeVisible();
}
const openChoice = (page: Page) => page.locator('[role=radio]:not([aria-disabled=true])').first();
async function answer(page: Page) {
  await openChoice(page).click();
  await page.getByTestId('check').click();
}

// nav: 'tabs' screens carry the app navigation (sidebar at >= 1024, tab bar below); 'none' focus
// screens show neither; other screens must at least never show the tab bar at desktop width.
type Route = { name: string; nav?: 'tabs' | 'none'; go: (page: Page, email: string, L: typeof en) => Promise<void> };
const ROUTES: Route[] = [
  { name: 'sign-in', go: async (p) => { await p.goto('/sign-in'); await expect(p.getByTestId('sign-in')).toBeVisible(); } },
  { name: 'language menu', go: async (p) => { await p.getByTestId('language').click(); await expect(p.getByTestId('language-menu')).toBeVisible(); } },
  { name: 'sign-up (filled)', go: async (p, email) => { await p.keyboard.press('Escape'); await expect(p.getByTestId('language-menu')).toHaveCount(0); await p.getByTestId('auth-tab-up').click(); await p.getByTestId('email').fill(email); await p.getByTestId('password').fill(PASS); await p.getByTestId('password-repeat').fill(PASS); } },
  { name: 'onboarding', go: async (p) => { await p.getByTestId('sign-up').click(); await expect(p.getByTestId('faculty-general-medicine')).toBeVisible(); } },
  { name: 'tour step 1', nav: 'tabs', go: async (p) => {
    await p.getByTestId('faculty-general-medicine').click();
    await p.getByTestId('year-2').click();
    await p.getByTestId('study-continue').click();
    await expect(p.getByTestId('tour-card')).toBeVisible();
  } },
  { name: 'home', nav: 'tabs', go: async (p) => { await p.getByTestId('tour-skip').click(); await expect(p.getByTestId('tour-card')).toHaveCount(0); await expect(p.getByTestId('test-phys-1')).toBeVisible(); } },
  { name: 'subject picker', go: async (p, _e, L) => {
    await p.getByRole('button', { name: new RegExp(`^${esc(L.changeSubject.replace('{subject}', ''))}`) }).click();
    await expect(p.getByRole('heading', { name: L.subjects })).toBeVisible();
  } },
  { name: 'test detail', go: async (p) => { await p.goto('/test/phys-1'); await expect(p.getByTestId('mode-practice')).toBeVisible(); } },
  { name: 'question', go: async (p) => { await p.getByTestId('mode-practice').click(); await expect(p.getByRole('radiogroup')).toBeVisible(); } },
  { name: 'question answered', go: async (p) => { await answer(p); await expect(p.getByTestId('next')).toBeVisible(); } },
  { name: 'result', go: async (p) => {
    for (let i = 0; i < 12 && !(await p.getByTestId('result-score').isVisible()); i++) {
      await p.getByTestId('next').click();
      await expect(openChoice(p).or(p.getByTestId('result-score')).first()).toBeVisible();
      if (await p.getByTestId('result-score').isVisible()) break;
      await answer(p);
    }
    await expect(p.getByTestId('result-score')).toBeVisible();
  } },
  { name: 'review', nav: 'tabs', go: async (p) => { await p.goto('/review'); await loaded(p); } },
  { name: 'review session', go: async (p) => { await p.goto('/review-session'); await loaded(p); } },
  { name: 'stats', nav: 'tabs', go: async (p) => { await p.goto('/progress'); await loaded(p); } },
  { name: 'library', go: async (p) => { await p.goto('/library/physiology'); await loaded(p); } },
  { name: 'compound question', go: async (p) => {
    await p.goto('/test/phys-4');
    await p.getByTestId('mode-practice').click();
    for (let i = 0; i < 3 && !(await p.getByTestId('statement-1').isVisible()); i++) {
      await expect(p.getByRole('radiogroup')).toBeVisible();
      if (await p.getByTestId('statement-1').isVisible()) break;
      await answer(p);
      await p.getByTestId('next').click();
      await expect(openChoice(p)).toBeVisible();
    }
    await expect(p.getByTestId('statement-1')).toBeVisible();
  } },
  { name: 'compound answered', go: async (p) => { await answer(p); await expect(p.getByTestId('next')).toBeVisible(); } },
  { name: 'full exam start', nav: 'none', go: async (p) => { await p.goto('/full-exam/physiology'); await expect(p.getByTestId('full-exam-start')).toBeVisible(); } },
  { name: 'full exam question', go: async (p) => { await p.getByTestId('full-exam-start').click(); await expect(p.getByRole('timer')).toBeVisible(); await expect(openChoice(p)).toBeVisible(); } },
  { name: 'pricing', go: async (p, _e, L) => { await p.goto('/'); await p.getByTestId('test-phys-2').click(); await expect(p.getByTestId('plan-group')).toBeVisible(); await expect(p.getByTestId('buy-subject')).toHaveText(L.buyInApp); } },
  { name: 'pricing from profile', go: async (p) => { await p.goto('/profile'); await p.getByTestId('profile-prices').click(); await expect(p.getByTestId('plan-year')).toBeVisible(); } },
  { name: 'profile', nav: 'tabs', go: async (p) => { await p.goto('/profile'); await expect(p.getByTestId('profile-delete-account')).toBeVisible(); } },
];

/** Measures the page; returns one line per violation: element and measured value. */
function measure(o: { vw: number; desktop: boolean; sidebar: boolean; phone: boolean; hy: boolean; ru: boolean; lang?: string; nav?: string }) {
  const out: string[] = [];
  const INTERACTIVE = 'a[href], button, input, textarea, select, [role=button], [role=link], [role=radio], [role=checkbox], [role=tab], [role=switch], [role=menuitem], [role=menuitemradio]';
  const hiddenTree = (el: Element) => !!el.closest('[aria-hidden=true], [inert]');
  const box = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || hiddenTree(el)) return null;
    for (let e: Element | null = el; e; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return null;
    }
    return r;
  };
  const name = (el: Element) => {
    const id = el.getAttribute('data-testid');
    const txt = (el.getAttribute('aria-label') || (el as HTMLElement).innerText || (el as HTMLInputElement).placeholder || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    return `${id ? `#${id}` : el.tagName.toLowerCase() + (el.getAttribute('role') ? `[${el.getAttribute('role')}]` : '')} "${txt}"`;
  };
  const px = (n: number) => `${Math.round(n)} px`;
  const inScrollX = (el: Element) => {
    for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) {
      const s = getComputedStyle(e).overflowX;
      if ((s === 'auto' || s === 'scroll') && e.scrollWidth > e.clientWidth) return true;
    }
    return false;
  };
  // covered by something else (a sheet, an overlay) at its centre: not reachable, not measured
  // the part actually drawn: the box cut by every ancestor that clips its overflow (ellipsis,
  // scroll views). Clipping and overlap are judged on this, sizes on the full box.
  const drawn = (el: Element, r: { left: number; right: number; top: number; bottom: number }) => {
    let { left, right, top, bottom } = r;
    for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
      const c = e.getBoundingClientRect();
      if (s.overflowX !== 'visible') { left = Math.max(left, c.left); right = Math.min(right, c.right); }
      if (s.overflowY !== 'visible') { top = Math.max(top, c.top); bottom = Math.min(bottom, c.bottom); }
    }
    return { left, right, top, bottom };
  };
  const hittable = (el: Element, r: DOMRect) => {
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (y < 0 || y > innerHeight || x < 0 || x > innerWidth) return true;
    const top = document.elementFromPoint(x, y);
    return !!top && (el === top || el.contains(top) || top.contains(el));
  };

  if (o.lang && document.documentElement.lang !== o.lang) out.push(`page language is "${document.documentElement.lang}" while the UI is ${o.lang}`);
  const sw = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
  if (sw > o.vw) out.push(`horizontal scroll: document scrollWidth ${px(sw)} > viewport ${px(o.vw)}`);

  const controls = [...document.querySelectorAll(INTERACTIVE)].map((el) => ({ el, r: box(el) }))
    .filter((c): c is { el: Element; r: DOMRect } => !!c.r && hittable(c.el, c.r));
  const sidebar = document.querySelector('[data-testid=sidebar]');
  const sidebarShown = !!sidebar && !!box(sidebar);
  const tabsShown = [...document.querySelectorAll('[role=tablist]:has([data-testid^="tab-"])')].some((t) => box(t));

  // text runs: the rendered line extent of each text node
  const texts: { el: Element; r: DOMRect; t: string }[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.textContent!.replace(/\s+/g, ' ').trim();
    const el = n.parentElement;
    if (!t || !el || el.closest('script, style, noscript') || !box(el)) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    const r = range.getBoundingClientRect();
    if (r.width >= 1 && r.height >= 1) texts.push({ el, r, t });
  }

  if (o.desktop) {
    for (const { el, r } of controls)
      if (el.matches('input, textarea, button, [role=button]') && r.width > 440) out.push(`control wider than 440 px: ${name(el)} is ${px(r.width)}`);
    for (const { el, r } of texts) if (r.width > 720) out.push(`text block wider than 720 px: ${name(el)} is ${px(r.width)}`);
    const content = [...texts.map((t) => t), ...controls].filter(({ el }) => !sidebar?.contains(el));
    if (content.length) {
      const left = Math.min(...content.map((c) => c.r.left)), right = Math.max(...content.map((c) => c.r.right));
      if (right - left > 1200) out.push(`content wider than 1200 px: spans ${px(left)} to ${px(right)} (${px(right - left)})`);
    }
  }
  if (o.nav === 'none') {
    if (sidebarShown) out.push('sidebar shown on a focus screen');
    if (tabsShown) out.push('tab bar shown on a focus screen');
  } else if (o.sidebar) {
    if (tabsShown) out.push('bottom tab bar shown at sidebar width');
    if (o.nav === 'tabs' && !sidebarShown) out.push('sidebar missing at sidebar width');
  } else {
    if (sidebarShown) out.push('sidebar shown below sidebar width');
    if (o.nav === 'tabs' && !tabsShown) out.push('bottom tab bar missing below sidebar width');
  }

  for (const { el, r } of [...controls, ...texts]) {
    const d = drawn(el, r);
    if (d.right - d.left > 0 && (d.right > o.vw + 1 || d.left < -1) && !inScrollX(el)) out.push(`clipped outside the viewport: ${name(el)} spans ${px(d.left)} to ${px(d.right)}`);
  }

  for (let i = 0; i < controls.length; i++)
    for (let j = i + 1; j < controls.length; j++) {
      const a = controls[i], b = controls[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      // per line box, so two links wrapping in one sentence are not one big rectangle each
      for (const ca of a.el.getClientRects()) for (const cb of b.el.getClientRects()) {
        const ra = drawn(a.el, ca), rb = drawn(b.el, cb);
        const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
        const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
        if (w > 1 && h > 1) out.push(`overlapping controls: ${name(a.el)} and ${name(b.el)} by ${px(w)} x ${px(h)}`);
      }
    }

  if (o.phone)
    for (const { el, r } of controls)
      if (r.width < 44 || r.height < 44) out.push(`tap target under 44 px: ${name(el)} is ${px(r.width)} x ${px(r.height)}`);

  if (o.ru) {
    // ru UI strings must be Cyrillic; content (questions, catalogue and library titles) is hy/en by design
    // and is skipped when marked with its own lang attribute or by its testID
    const CONTENT = '[data-testid^=choice-], [data-testid^=statement-], [data-testid^=library-], [data-testid^=test-], [data-testid^=subject-], [data-testid^=faculty-], [data-testid=question], [role=radiogroup], h1';
    const OK = /Examed|ysmu\.am|https?:\/\/|@|\.pdf$|^XP$|App Store|Google Play|Enter|English|Հայերեն|Русский/;
    for (const { el, t } of texts) {
      const words = t.split(' ').filter((w) => /[A-Za-z\u0531-\u058F]/.test(w));
      const lang = el.closest('[lang]:not(html)')?.getAttribute('lang');
      if (!/[\u0400-\u04FF]/.test(t) && words.length > 3 && !OK.test(t) && !el.closest(CONTENT) && (!lang || lang === 'ru')) out.push(`untranslated text in ru: ${name(el)}: "${t.slice(0, 80)}"`);
    }
  }
  if (o.hy) {
    const BRAND = /Examed|ysmu\.am|https?:\/\/|@|\.pdf$/i;
    for (const { el, t } of texts) {
      const words = t.split(' ').filter((w) => /[A-Za-z]/.test(w));
      if (!/[Ա-֏]/.test(t) && words.length > 3 && !BRAND.test(t)) out.push(`Latin-only text in hy: ${name(el)}: "${t.slice(0, 80)}"`);
    }
  }
  // sibling choice cards (faculty, year, goal, plans, modes, tiles, subjects): the app marks each
  // group with a *-group testID. In one row, every cell has the same width and height.
  const groups = new Map<Element, Map<string, { el: Element; r: DOMRect }[]>>();
  // explicit groups from the app: the direct children of a *-group container are its cells
  // review-rows and plan-group: the cards themselves are the cells (they hold their own buttons)
  for (const g of document.querySelectorAll('[data-testid$=-group], [data-testid=review-rows]')) {
    const whole = ['review-rows', 'plan-group'].includes(g.getAttribute('data-testid')!);
    const cells = [...g.children].map((cell) => {
      const el = whole || cell.matches('[role=radio], [role=button], [role=link]') ? cell : cell.querySelector('[role=radio], [role=button], [role=link]') ?? cell;
      return { el, r: box(el) };
    }).filter((c): c is { el: Element; r: DOMRect } => !!c.r);
    if (cells.length > 1) {
      const byKey = groups.get(g) ?? new Map();
      groups.set(g, byKey.set(`group|${g.getAttribute('data-testid')}`, cells));
    }
  }
  for (const byKey of groups.values())
    for (const [key, members] of byKey) {
      if (members.length < 2) continue;
      const rows = new Map<number, typeof members>();
      for (const m of members) {
        const top = [...rows.keys()].find((t) => Math.abs(t - m.r.top) <= 1) ?? m.r.top;
        rows.set(top, [...(rows.get(top) ?? []), m]);
      }
      for (const row of rows.values()) {
        if (row.length < 2) continue;
        const ws = row.map((m) => m.r.width), hs = row.map((m) => m.r.height);
        const spread = (a: number[]) => Math.max(...a) - Math.min(...a);
        if (spread(ws) > 1 || spread(hs) > 1)
          out.push(`unequal cards in group ${key.split('|')[1]}: ${row.map((m) => `${m.el.getAttribute('data-testid') ?? name(m.el)} ${px(m.r.width)} x ${px(m.r.height)}`).join(', ')}`);
      }
    }
  return [...new Set(out)];
}

/** Console errors and failed requests since the last call. */
function recorder(page: Page) {
  let log: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') log.push(`console error: ${m.text().slice(0, 160)}`); });
  page.on('pageerror', (e) => log.push(`page error: ${e.message.slice(0, 160)}`));
  page.on('response', (r) => { if (r.status() >= 400) log.push(`HTTP ${r.status()} ${r.request().method()} ${r.url().replace(/\?.*/, '')}`); });
  page.on('requestfailed', (r) => log.push(`request failed: ${r.url().replace(/\?.*/, '')} (${r.failure()?.errorText})`));
  return () => { const l = log; log = []; return l; };
}

for (const lang of LANGS) for (const [width, height] of VIEWPORTS) {
  test(`layout at ${width}x${height} in ${lang}`, async ({ page }) => {
    test.setTimeout(420_000);
    const L = TABLES[lang];
    await page.addInitScript((l) => localStorage.setItem('lang', l), lang);
    await page.setViewportSize({ width, height });
    const drain = recorder(page);
    const email = `layout-${width}-${Date.now()}@e2e.test`; // matches the afterAll sweep
    for (const route of ROUTES) {
      await test.step(route.name, async () => {
        await route.go(page, email, L);
        await page.waitForTimeout(400); // let entering animations settle before measuring
        const found = await page.evaluate(measure, { vw: width, desktop: width >= DESKTOP, sidebar: width >= SIDEBAR_FROM, phone: width < 768, hy: lang === 'hy', ru: lang === 'ru', lang, nav: route.nav });
        expect.soft([...found, ...drain()], `${route.name} at ${width}x${height} in ${lang}`).toEqual([]);
      });
      if (route.name === 'subject picker') await page.keyboard.press('Escape');
    }
  });
}

// Dialogs and sheets: opened with the page at the top and after scrolling everything to the bottom.
// The backdrop covers the viewport exactly, the panel sits inside it and centred, the page behind
// does not scroll, focus is inside, Escape closes it. Sign out has no dialog (it signs out at once).
const HY = TABLES.hy;
type Dialog = { name: string; menu?: string; at: (p: Page) => Promise<void>; open: (p: Page) => Promise<void> };
const DIALOGS: Dialog[] = [
  { name: 'subject picker', at: (p) => p.goto('/').then(() => undefined),
    open: (p) => p.getByRole('button', { name: new RegExp(`^${esc(HY.changeSubject.replace('{subject}', ''))}`) }).click() },
  { name: 'report question', at: async (p) => { await p.goto('/test/phys-1'); await p.getByTestId('mode-practice').click(); await expect(p.getByRole('radiogroup')).toBeVisible(); },
    open: (p) => p.getByRole('button', { name: HY.report }).or(p.getByRole('button', { name: HY.reportShort })).first().click() },
  { name: 'submit exam', at: async (p) => {
    await p.goto('/test/phys-4');
    await p.getByTestId('mode-exam').click();
    await expect(p.getByRole('radiogroup')).toBeVisible();
    for (let i = 0; i < 5 && !(await p.getByTestId('exam-submit').isVisible()); i++) await p.getByTestId('exam-next').click();
  }, open: (p) => p.getByTestId('exam-submit').click() },
  { name: 'leave exam', at: async (p) => { await p.goto('/test/phys-1'); await p.getByTestId('mode-exam').click(); await expect(p.getByRole('timer')).toBeVisible(); },
    open: (p) => p.getByTestId('close-exam').click() },
  { name: 'daily goal', at: (p) => p.goto('/profile').then(() => undefined), open: (p) => p.getByRole('button', { name: new RegExp(`^${esc(HY.dailyGoal)}`) }).first().click() },
  { name: 'delete account', at: (p) => p.goto('/profile').then(() => undefined), open: (p) => p.getByTestId('profile-delete-account').click() },
  { name: 'study profile', at: (p) => p.goto('/profile').then(() => undefined), open: (p) => p.getByTestId('profile-study').click() },
  { name: 'language menu', menu: 'profile-language-menu', at: (p) => p.goto('/profile').then(() => undefined), open: (p) => p.getByTestId('profile-language').click() },
];

/** Scroll offsets of the window and every scrolled box, as one string. */
const scrollState = (p: Page) => p.evaluate(() => [scrollY, ...[...document.querySelectorAll('*')].filter((e) => e.scrollHeight > e.clientHeight + 1).map((e) => e.scrollTop)].join(','));
const scrollAllDown = (p: Page) => p.evaluate(() => {
  scrollTo(0, document.documentElement.scrollHeight);
  for (const e of document.querySelectorAll('*')) {
    const s = getComputedStyle(e).overflowY;
    if ((s === 'auto' || s === 'scroll') && e.scrollHeight > e.clientHeight + 1) e.scrollTop = e.scrollHeight;
  }
});

function measureDialog(o: { vw: number; vh: number }) {
  const out: string[] = [];
  const px = (n: number) => `${Math.round(n)} px`;
  const panels = [...document.querySelectorAll('[data-testid=sheet], [aria-modal=true], [role=dialog]')].filter((e, i, a) => e.getBoundingClientRect().height > 0 && !a.some((o) => o !== e && o.contains(e)));
  if (panels.length !== 1) return [`expected one open dialog, found ${panels.length}`];
  const panel = panels[0], r = panel.getBoundingClientRect();
  const scrim = panel.previousElementSibling, s = scrim?.getBoundingClientRect();
  if (!s || Math.abs(s.left) > 1 || Math.abs(s.top) > 1 || Math.abs(s.width - o.vw) > 1 || Math.abs(s.height - o.vh) > 1)
    out.push(`backdrop is not the viewport: ${s ? `${px(s.left)},${px(s.top)} ${px(s.width)} x ${px(s.height)}` : 'missing'} (viewport ${o.vw} x ${o.vh})`);
  if (r.top < -1 || r.left < -1 || r.right > o.vw + 1 || r.bottom > o.vh + 1)
    out.push(`dialog outside the viewport: top ${px(r.top)}, bottom ${px(r.bottom)}, left ${px(r.left)}, right ${px(r.right)}`);
  // centred in the app column: the window minus the sidebar when one shows
  const side = document.querySelector('[data-testid=sidebar]')?.getBoundingClientRect();
  const colLeft = side && side.width > 0 ? side.right : 0;
  const off = (r.left + r.right) / 2 - (colLeft + o.vw) / 2;
  if (Math.abs(off) > 2) out.push(`dialog not centred in the column: ${px(off)} off centre`);
  // the live-site defect: an overflow-hidden column scrolled under the sheet and pushed it off screen
  for (const e of document.querySelectorAll('*'))
    if (getComputedStyle(e).overflowY === 'hidden' && e.scrollTop > 0) out.push(`overflow-hidden box scrolled by ${px(e.scrollTop)}: ${e.tagName.toLowerCase()}${e.getAttribute('data-testid') ? '#' + e.getAttribute('data-testid') : ''}`);
  if (!panel.contains(document.activeElement)) out.push(`focus outside the dialog: ${document.activeElement?.tagName}`);
  return out;
}

for (const [width, height] of VIEWPORTS) {
  test(`dialogs at ${width}x${height}`, async ({ page }) => {
    test.setTimeout(420_000);
    await page.setViewportSize({ width, height });
    const drain = recorder(page);
    const email = `layout-${width}-${Date.now()}@e2e.test`;
    for (const r of ROUTES.slice(0, ROUTES.findIndex((x) => x.name === 'home') + 1)) await r.go(page, email, HY); // sign up to Home
    for (const d of DIALOGS) for (const scrolled of [false, true]) {
      await test.step(`${d.name}${scrolled ? ', scrolled' : ''}`, async () => {
        await d.at(page);
        await page.waitForTimeout(300);
        if (scrolled) await scrollAllDown(page);
        await d.open(page);
        const open = d.menu ? page.getByTestId(d.menu) : page.locator('[data-testid=sheet], [aria-modal=true], [role=dialog]').first();
        await expect(open).toBeVisible();
        await page.waitForTimeout(1000); // the panel slides in
        const found = d.menu
          ? await open.evaluate((m, o) => { const r = m.getBoundingClientRect(); return r.top < -1 || r.left < -1 || r.bottom > o.vh + 1 || r.right > o.vw + 1 ? [`menu outside the viewport: ${Math.round(r.left)},${Math.round(r.top)} to ${Math.round(r.right)},${Math.round(r.bottom)}`] : []; }, { vw: width, vh: height })
          : await page.evaluate(measureDialog, { vw: width, vh: height });
        const before = await scrollState(page);
        await page.mouse.move(4, 4);
        await page.mouse.wheel(0, 600);
        await page.waitForTimeout(300);
        if (!d.menu && (await scrollState(page)) !== before) found.push('page behind scrolled while the dialog was open');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);
        if (await open.count()) found.push('Escape did not close it');
        expect.soft([...found, ...drain()], `${d.name}${scrolled ? ' (scrolled)' : ''} at ${width}x${height}`).toEqual([]);
      });
    }
  });
}

test('empty sign-in and sign-up send nothing and show a translated field error', async ({ page }) => {
  for (const button of ['sign-in', 'sign-up']) {
    await page.goto('/sign-in');
    if (button === 'sign-up') await page.getByTestId('auth-tab-up').click();
    await expect(page.getByTestId(button)).toBeVisible();
    const before = new Set((await page.locator('body').innerText()).split('\n').map((s) => s.trim()));
    const sent: string[] = [];
    page.on('request', (r) => { if (r.url().startsWith(status.API_URL)) sent.push(`${r.method()} ${r.url().replace(/\?.*/, '')}`); });
    await page.getByTestId(button).click();
    await page.waitForTimeout(1500);
    expect.soft(sent, `${button}: requests sent with empty fields`).toEqual([]);
    const added = (await page.locator('body').innerText()).split('\n').map((s) => s.trim()).filter((s) => s && !before.has(s));
    expect.soft(added.filter((s) => /[Ա-֏]/.test(s)), `${button}: a field error in Armenian (new text: ${JSON.stringify(added)})`).not.toEqual([]);
    expect.soft(added.filter((s) => /[A-Za-z]{3}/.test(s) && !/[Ա-֏]/.test(s)), `${button}: untranslated text`).toEqual([]);
    page.removeAllListeners('request');
  }
});

test('sign-in and register are tabs, each with exactly one submit button', async ({ page }) => {
  await page.goto('/sign-in');
  await expect(page.getByRole('tablist')).toBeVisible();
  for (const [tab, submit, other] of [['up', 'sign-up', 'sign-in'], ['in', 'sign-in', 'sign-up']]) {
    await page.getByTestId(`auth-tab-${tab}`).click();
    await expect(page.getByTestId(`auth-tab-${tab}`)).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId(submit)).toHaveCount(1);
    await expect(page.getByTestId(other)).toHaveCount(0);
    await expect(page.getByTestId('password-repeat')).toHaveCount(tab === 'up' ? 1 : 0);
  }
  // keyboard: the tabs are reachable with Tab and switch with Enter
  await page.getByTestId('auth-tab-in').focus();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('auth-tab-up')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('auth-tab-up')).toHaveAttribute('aria-selected', 'true');
  // a different repeat sends nothing and says so
  await page.getByTestId('email').fill('nobody@e2e.test');
  await page.getByTestId('password').fill(PASS);
  await page.getByTestId('password-repeat').fill(`${PASS}x`);
  await page.getByTestId('sign-up').click();
  await expect(page.getByTestId('password-repeat-error')).toBeVisible();
});

test.afterAll(async () => {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  for (const u of data.users) if (/^layout-\d+-\d+@e2e\.test$/.test(u.email ?? '')) await admin.auth.admin.deleteUser(u.id);
});
