import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "@playwright/test";
import { BUILD_DIR, GUIDES_DIR, type Block, type GuideMeta, type Section } from "./guide";

/** Builds guides/Nipuna-CRM-<Role>-Guide.pdf for every role captured into guides/_build/<role>/content.json. */

const LOGO = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../public/nipuna-logo.png")).href;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const inline = (s: string) =>
  esc(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*\s][^*]*?)\*/g, "<em>$1</em>")
    .replace(/`(.+?)`/g, "<code>$1</code>")
    .replace(/\((\d{1,2})\)/g, '<span class="num">$1</span>');

function block(b: Block, fig: { n: number }) {
  switch (b.type) {
    case "p":
      return `<p>${inline(b.text)}</p>`;
    case "steps":
      return `<ol class="steps">${b.items.map((i) => `<li>${inline(i)}</li>`).join("")}</ol>`;
    case "bullets":
      return `<ul>${b.items.map((i) => `<li>${inline(i)}</li>`).join("")}</ul>`;
    case "note": {
      const label = { tip: "Tip", rule: "Rule", warn: "Watch out" }[b.kind];
      return `<div class="note ${b.kind}"><b>${label}</b><span>${inline(b.text)}</span></div>`;
    }
    case "table":
      return `<table><thead><tr>${b.head.map((h) => `<th>${inline(h)}</th>`).join("")}</tr></thead><tbody>${b.rows
        .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
        .join("")}</tbody></table>`;
    case "img":
      return `<figure><img src="${b.file}"><figcaption><b>Figure ${++fig.n}</b> ${inline(b.caption)}</figcaption></figure>`;
  }
}

function html(meta: GuideMeta, sections: Section[]) {
  const date = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
  const fig = { n: 0 };
  const ids = sections.map((s, i) => ({ ...s, id: `s${i + 1}` }));
  const overview = ids.filter((s) => s.part === "overview");
  const workflows = ids.filter((s) => s.part === "workflow");
  const num = (s: (typeof ids)[number]) => (s.part === "overview" ? `1.${overview.indexOf(s) + 1}` : `2.${workflows.indexOf(s) + 1}`);
  const toc = (list: typeof ids) => list.map((s) => `<li><a href="#${s.id}"><span>${num(s)}</span>${esc(s.title)}</a></li>`).join("");
  const body = (list: typeof ids) =>
    list
      .map(
        (s) =>
          `<section class="${s.part}" id="${s.id}"><h2><span>${num(s)}</span>${esc(s.title)}</h2>${s.blocks.map((b) => block(b, fig)).join("\n")}</section>`,
      )
      .join("\n");

  return `<!doctype html><html><head><meta charset="utf-8"><title>Nipuna CRM — ${esc(meta.title)} guide</title><style>
  @page { size: A4; margin: 16mm 15mm 18mm; }
  :root { --brand: #6251da; --ink: #1d2030; --muted: #5d6275; --line: #e3e5ee; --soft: #f4f3fd; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 10.5pt/1.55 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: var(--ink); -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .cover { height: 258mm; display: flex; flex-direction: column; page-break-after: always; }
  .cover img { width: 62mm; }
  .cover .band { margin-top: 52mm; border-left: 6px solid var(--brand); padding: 4mm 0 4mm 8mm; }
  .cover .kicker { color: var(--brand); font-weight: 700; letter-spacing: .12em; text-transform: uppercase; font-size: 10pt; }
  .cover h1 { font-size: 32pt; line-height: 1.15; margin: 3mm 0 4mm; }
  .cover .sub { font-size: 13pt; color: var(--muted); max-width: 140mm; }
  .cover .meta { margin-top: auto; border-top: 1px solid var(--line); padding-top: 5mm; color: var(--muted); font-size: 9.5pt; display: grid; grid-template-columns: auto 1fr; gap: 1.5mm 8mm; }
  .cover .meta b { color: var(--ink); font-weight: 600; }
  .toc { page-break-after: always; }
  .toc h2 { font-size: 20pt; margin: 0 0 6mm; }
  .toc h3 { color: var(--brand); text-transform: uppercase; letter-spacing: .08em; font-size: 9.5pt; margin: 7mm 0 2mm; }
  .toc ol { list-style: none; padding: 0; margin: 0; }
  .toc li a { display: flex; gap: 4mm; padding: 2mm 0; border-bottom: 1px solid var(--line); color: var(--ink); text-decoration: none; font-size: 11pt; }
  .toc li a span { color: var(--brand); font-weight: 700; min-width: 9mm; }
  .toc .how { margin-top: 9mm; background: var(--soft); border-radius: 3mm; padding: 4mm 5mm; font-size: 9.5pt; color: var(--muted); }
  .part { page-break-before: always; page-break-after: always; padding-top: 40mm; }
  .part .kicker { color: var(--brand); font-weight: 700; letter-spacing: .12em; text-transform: uppercase; font-size: 10pt; }
  .part h1 { font-size: 28pt; margin: 2mm 0 3mm; }
  .part p { color: var(--muted); font-size: 12pt; max-width: 150mm; }
  section + section { margin-top: 11mm; }
  h2 { font-size: 17pt; margin: 0 0 4mm; padding-bottom: 2.5mm; border-bottom: 2px solid var(--brand); display: flex; gap: 4mm; break-after: avoid; }
  h2 span { color: var(--brand); }
  h2 + p { break-before: avoid; }
  p { margin: 0 0 3mm; orphans: 3; widows: 3; }
  ol.steps { counter-reset: step; list-style: none; padding: 0; margin: 0 0 4mm; }
  ol.steps li { counter-increment: step; position: relative; padding: 1.4mm 0 1.4mm 10mm; break-inside: avoid; }
  ol.steps li::before { content: counter(step); position: absolute; left: 0; top: 1.2mm; width: 6.4mm; height: 6.4mm; border-radius: 50%; background: var(--brand); color: #fff; font-weight: 700; font-size: 8.5pt; text-align: center; line-height: 6.4mm; }
  ul { margin: 0 0 4mm; padding-left: 6mm; } ul li { margin: 1mm 0; }
  .num { display: inline-block; min-width: 4.6mm; height: 4.6mm; padding: 0 1mm; border-radius: 2.3mm; background: #e5262f; color: #fff; font-weight: 700; font-size: 7.5pt; line-height: 4.6mm; text-align: center; vertical-align: .3mm; }
  code { font: 9pt ui-monospace, Menlo, monospace; background: var(--soft); padding: .3mm 1.2mm; border-radius: 1mm; }
  .note { display: flex; gap: 3mm; border-radius: 2.5mm; padding: 3mm 4mm; margin: 0 0 4mm; font-size: 9.8pt; break-inside: avoid; }
  .note b { flex: none; text-transform: uppercase; font-size: 8pt; letter-spacing: .08em; padding-top: .5mm; min-width: 16mm; }
  .note.tip { background: #eef8f1; border-left: 4px solid #2f9e5b; } .note.tip b { color: #22804a; }
  .note.rule { background: var(--soft); border-left: 4px solid var(--brand); } .note.rule b { color: var(--brand); }
  .note.warn { background: #fff5e8; border-left: 4px solid #e08a12; } .note.warn b { color: #b86d06; }
  table { width: 100%; border-collapse: collapse; margin: 0 0 5mm; font-size: 9.5pt; break-inside: auto; }
  th { text-align: left; background: var(--soft); color: var(--brand); font-weight: 700; }
  th, td { padding: 2mm 2.5mm; border-bottom: 1px solid var(--line); vertical-align: top; }
  tr { break-inside: avoid; }
  figure { margin: 2mm 0 6mm; break-inside: avoid; }
  figure img { width: auto; max-width: 100%; max-height: 150mm; border: 1px solid var(--line); border-radius: 2mm; box-shadow: 0 1mm 3mm rgba(30, 30, 60, .08); display: block; }
  figcaption { font-size: 9pt; color: var(--muted); margin-top: 2mm; } figcaption b { color: var(--ink); margin-right: 1.5mm; }
  </style></head><body>
  <div class="cover">
    <img src="${LOGO}">
    <div class="band">
      <div class="kicker">Nipuna CRM · Product guide</div>
      <h1>${esc(meta.title)}</h1>
      <div class="sub">${inline(meta.subtitle)}</div>
    </div>
    <div class="meta">
      <span>Edition</span><b>${date}</b>
      <span>Screenshots</span><b>Taken in the development system with sample data (account: ${esc(meta.account)})</b>
      <span>Covers</span><b>${overview.length} overview sections · ${workflows.length} step-by-step workflows</b>
    </div>
  </div>
  <div class="toc">
    <h2>Contents</h2>
    <h3>Part 1 · Your role at a glance</h3><ol>${toc(overview)}</ol>
    <h3>Part 2 · Step-by-step workflows</h3><ol>${toc(workflows)}</ol>
    <div class="how"><b>How to read the screenshots.</b> Red boxes with numbers <span class="num">1</span> <span class="num">2</span> point at the buttons and fields the steps talk about. Names, phone numbers and amounts are sample data.</div>
  </div>
  <div class="part"><div class="kicker">Part 1</div><h1>Your role at a glance</h1><p>What you can see, what you are responsible for, and the rules the system enforces for you.</p></div>
  ${body(overview)}
  <div class="part"><div class="kicker">Part 2</div><h1>Step-by-step workflows</h1><p>Your main daily tasks, one at a time, with the screen you will see at each step.</p></div>
  ${body(workflows)}
  </body></html>`;
}

const roles = fs.existsSync(BUILD_DIR) ? fs.readdirSync(BUILD_DIR).filter((d) => fs.existsSync(path.join(BUILD_DIR, d, "content.json"))) : [];

for (const role of roles) {
  test(`build ${role} PDF`, async ({ page }) => {
    const dir = path.join(BUILD_DIR, role);
    const { meta, sections } = JSON.parse(fs.readFileSync(path.join(dir, "content.json"), "utf8")) as { meta: GuideMeta; sections: Section[] };
    const file = path.join(dir, "guide.html");
    fs.writeFileSync(file, html(meta, sections));
    await page.goto(pathToFileURL(file).href);
    await page.waitForLoadState("load");
    // One scale for every screenshot (0.2 mm per screen pixel; images are captured at 2x), capped by the page width
    // and 140 mm height: a dialog prints readable without filling the page, a full screen fills the width.
    await page.evaluate(() => {
      for (const img of Array.from(document.querySelectorAll<HTMLImageElement>("figure img"))) {
        const w = img.naturalWidth / 2;
        const h = img.naturalHeight / 2;
        img.style.width = `${Math.min(w * 0.2, 180, (140 * w) / h)}mm`;
        img.style.maxHeight = "none";
      }
    });
    const name = meta.title.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
    await page.pdf({
      path: path.join(GUIDES_DIR, `Nipuna-CRM-Guide-${name}.pdf`),
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate: `<div style="width:100%;font:8px -apple-system,Helvetica,sans-serif;color:#8a8fa3;padding:0 15mm;display:flex;justify-content:space-between"><span>Nipuna CRM · ${esc(meta.title)} guide</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
    });
  });
}
