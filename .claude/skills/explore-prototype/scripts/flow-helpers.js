// Helpers for scripted prototype workflows (one browser session, in-memory data preserved).
// Require from your flow script run with NODE_PATH=<pw>/node_modules.
const { chromium } = require('playwright');

async function start({ role = 'Founder / CEO', branch = 'All Branches', path = '/dashboard', base = 'http://127.0.0.1:5173', headless = true } = {}) {
  const browser = await chromium.launch({ channel: 'chrome', headless });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await ctx.addInitScript(([r, b]) => {
    if (!sessionStorage.getItem('nipuna-prototype-role')) {
      sessionStorage.setItem('nipuna-prototype-role', r);
      sessionStorage.setItem('nipuna-prototype-branch', b);
    }
  }, [role, branch]);
  const page = await ctx.newPage();

  // Collect every toast as it appears (they auto-dismiss)
  const seen = [];
  await page.exposeFunction('__toast', (t) => seen.push(t));
  await page.addInitScript(() => new MutationObserver(() => document.querySelectorAll('[data-sonner-toast]:not([data-seen])').forEach((e) => {
    e.setAttribute('data-seen', '1');
    window.__toast(e.innerText.replace(/\n/g, ' '));
  })).observe(document, { subtree: true, childList: true }));

  await page.goto(base + path, { waitUntil: 'networkidle' });

  return {
    page,
    /** Toast texts since the last call. */
    toasts: async () => { await page.waitForTimeout(700); return seen.splice(0).join(' | ') || '(none)'; },
    /** Client-side navigation through an in-app link (keeps state; page.goto would reset it). */
    clickLink: async (href) => { await page.locator(`a[href="${href}"]`).first().click(); await page.waitForTimeout(600); },
    /** Switch role with the shell's Prototype Role selector (navigates to that role's home). */
    switchRole: async (r) => {
      await page.getByRole('combobox', { name: 'Prototype Role' }).click();
      await page.getByRole('option', { name: r, exact: true }).click();
      await page.waitForTimeout(700);
    },
    /** Page text starting at a heading, flattened (for quick assertions / logging). */
    section: async (title, length = 600) => {
      const text = await page.locator('body').innerText();
      const i = text.indexOf(title);
      return i < 0 ? `(not found: ${title})` : text.slice(i, i + length).replace(/\n/g, ' ');
    },
    close: () => browser.close(),
  };
}

module.exports = { start };
