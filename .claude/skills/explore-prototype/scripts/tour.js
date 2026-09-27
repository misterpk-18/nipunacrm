// Tour every prototype route: full-page screenshot + page text per route.
// Usage: NODE_PATH=<pw>/node_modules ROLE="Founder / CEO" BRANCH="All Branches" OUT=<dir> BASE=http://127.0.0.1:5173 node tour.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:5173';
const ROLE = process.env.ROLE || 'Founder / CEO';
const BRANCH = process.env.BRANCH || 'All Branches';
const OUT = process.env.OUT || path.join(process.cwd(), 'tour');
const ROUTES_DIR = path.resolve(__dirname, '../../../../prototype/src/routes');

// Sample IDs for dynamic segments (from src/lib/crm-store.tsx)
const SAMPLE_IDS = {
  $leadId: 'LD-24091',
  $personId: 'PER-GNT-00148',
  $invoiceId: 'INV-GNT-2627-0001',
  $batchId: 'BT-GNT-DS-2610',
};

function routesFromFiles() {
  const skip = new Set(['__root', 'index']);  // index = login screen
  const urls = new Set();
  for (const file of fs.readdirSync(ROUTES_DIR)) {
    if (!file.endsWith('.tsx')) continue;
    const name = file.replace(/\.tsx$/, '');
    if (skip.has(name)) continue;
    const parts = name.split('.').filter((p) => p !== 'index').map((p) => SAMPLE_IDS[p] || p);
    urls.add('/' + parts.join('/'));
  }
  return [...urls].sort();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const routes = routesFromFiles();
  const browser = await chromium.launch({ channel: 'chrome' });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await ctx.addInitScript(([role, branch]) => {
    sessionStorage.setItem('nipuna-prototype-role', role);
    sessionStorage.setItem('nipuna-prototype-branch', branch);
  }, [ROLE, BRANCH]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`${page.url()}: ${e.message}`));

  let text = `Role: ${ROLE} · Branch: ${BRANCH} · ${new Date().toISOString()}\n`;
  for (const [i, route] of routes.entries()) {
    await page.goto(BASE + route, { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);
    const file = `${String(i + 1).padStart(2, '0')}-${route.slice(1).replace(/\//g, '_') || 'root'}.png`;
    await page.screenshot({ path: path.join(OUT, file), fullPage: true });
    const body = await page.locator('main').first().innerText().catch(() => page.locator('body').innerText());
    text += `\n\n########## ${route}  (${file})\n${body.replace(/\n{2,}/g, '\n')}`;
  }
  fs.writeFileSync(path.join(OUT, 'tour.txt'), text);
  console.log(`Toured ${routes.length} routes as "${ROLE}" → ${OUT} · page errors: ${errors.length}`);
  errors.slice(0, 10).forEach((e) => console.log('  ', e));
  await browser.close();
})();
