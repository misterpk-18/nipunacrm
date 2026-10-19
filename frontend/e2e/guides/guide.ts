import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Locator, type Page } from "@playwright/test";

/**
 * A role guide under construction. A role's .guide.ts walks through the app as that role, writing the text
 * and taking annotated screenshots as it goes; `save()` writes guides/_build/<role>/content.json, which
 * build.guide.ts turns into the PDF.
 *
 * Text accepts **bold** and `code`. Keep it in the reader's words: what to click, what they will see.
 */

export const GUIDES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../guides");
export const BUILD_DIR = path.join(GUIDES_DIR, "_build");

export type Block =
  | { type: "p"; text: string }
  | { type: "steps"; items: string[] }
  | { type: "bullets"; items: string[] }
  | { type: "note"; kind: "tip" | "rule" | "warn"; text: string }
  | { type: "table"; head: string[]; rows: string[][] }
  | { type: "img"; file: string; caption: string; marks: string[] };

export type Section = { part: "overview" | "workflow"; title: string; blocks: Block[] };

export type GuideMeta = {
  /** File-safe id, e.g. "sales". */
  role: string;
  /** Cover title, e.g. "Sales (Counsellor) & Front Office". */
  title: string;
  /** One line under the title. */
  subtitle: string;
  /** Account used for the screenshots, shown on the cover. */
  account: string;
};

export type Mark = Locator | { at: Locator; label?: string };

export class Guide {
  private sections: Section[] = [];
  private current: Section | null = null;
  private shotNo = 0;
  readonly dir: string;

  constructor(
    readonly page: Page,
    readonly meta: GuideMeta,
  ) {
    this.dir = path.join(BUILD_DIR, meta.role);
    fs.rmSync(this.dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(this.dir, "img"), { recursive: true });
  }

  /** Part 1 of the PDF: who the role is, what it sees, its rules. */
  overview(title: string) {
    return this.start("overview", title);
  }

  /** Part 2 of the PDF: one daily workflow, step by step. */
  workflow(title: string) {
    return this.start("workflow", title);
  }

  private start(part: Section["part"], title: string) {
    this.current = { part, title, blocks: [] };
    this.sections.push(this.current);
    this.save(); // keep partial progress if a later step fails
    return this;
  }

  private add(block: Block) {
    if (!this.current) throw new Error("Start a section with overview() or workflow() first");
    this.current.blocks.push(block);
    return this;
  }

  p(text: string) {
    return this.add({ type: "p", text });
  }
  steps(...items: string[]) {
    return this.add({ type: "steps", items });
  }
  bullets(...items: string[]) {
    return this.add({ type: "bullets", items });
  }
  tip(text: string) {
    return this.add({ type: "note", kind: "tip", text });
  }
  rule(text: string) {
    return this.add({ type: "note", kind: "rule", text });
  }
  warn(text: string) {
    return this.add({ type: "note", kind: "warn", text });
  }
  table(head: string[], ...rows: string[][]) {
    return this.add({ type: "table", head, rows });
  }

  /**
   * Screenshot of the viewport (or of `focus`, e.g. a dialog) with numbered red boxes on `marks`.
   * Mark numbers match the order given, so the caption / steps can say "(1)", "(2)".
   * Waits for the network to settle and loading text to vanish first.
   */
  async shot(caption: string, marks: Mark[] = [], opts: { focus?: Locator; pad?: number; fullPage?: boolean } = {}) {
    const page = this.page;
    await settle(page);
    const items = marks.map((m) => ("at" in m ? m : { at: m, label: undefined }));
    if (items[0]) await items[0].at.first().scrollIntoViewIfNeeded().catch(() => undefined);
    const boxes: { x: number; y: number; w: number; h: number; n: string }[] = [];
    for (const [i, m] of items.entries()) {
      const loc = m.at.first();
      await expect(loc, `mark ${i + 1} for "${caption}"`).toBeVisible();
      const b = (await loc.boundingBox())!;
      boxes.push({ x: b.x, y: b.y, w: b.width, h: b.height, n: m.label ?? String(i + 1) });
    }
    await page.evaluate((list) => {
      const root = document.createElement("div");
      root.id = "__guide_marks";
      root.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
      for (const b of list) {
        const box = document.createElement("div");
        box.style.cssText = `position:absolute;left:${b.x - 4}px;top:${b.y - 4}px;width:${b.w + 8}px;height:${b.h + 8}px;border:3px solid #e5262f;border-radius:8px;box-shadow:0 0 0 3px rgba(229,38,47,.18)`;
        const badge = document.createElement("div");
        badge.textContent = b.n;
        const left = b.x - 16 < 2 ? b.x + b.w - 10 : b.x - 16;
        badge.style.cssText = `position:absolute;left:${left}px;top:${Math.max(2, b.y - 16)}px;min-width:24px;height:24px;padding:0 6px;box-sizing:border-box;border-radius:12px;background:#e5262f;color:#fff;font:700 13px/24px system-ui,sans-serif;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.35)`;
        root.append(box, badge);
      }
      document.body.append(root);
    }, boxes);

    const file = `${String(++this.shotNo).padStart(2, "0")}.jpg`;
    const out = path.join(this.dir, "img", file);
    if (opts.focus) {
      const b = (await opts.focus.first().boundingBox())!;
      const pad = opts.pad ?? 16;
      const vp = page.viewportSize()!;
      const x = Math.max(0, b.x - pad);
      const y = Math.max(0, b.y - pad);
      await page.screenshot({
        path: out,
        type: "jpeg",
        quality: 88,
        clip: { x, y, width: Math.min(vp.width - x, b.width + pad * 2), height: Math.min(vp.height - y, b.height + pad * 2) },
      });
    } else {
      await page.screenshot({ path: out, type: "jpeg", quality: 88, fullPage: opts.fullPage ?? false });
    }
    await page.evaluate(() => document.getElementById("__guide_marks")?.remove());
    this.add({ type: "img", file: `img/${file}`, caption, marks: items.map((m, i) => m.label ?? String(i + 1)) });
    return this;
  }

  save() {
    fs.writeFileSync(path.join(this.dir, "content.json"), JSON.stringify({ meta: this.meta, sections: this.sections }, null, 2));
  }
}

/** Network idle, no "Loading…" text and no skeletons, then a short pause for animations. */
export async function settle(page: Page) {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await expect(page.getByText(/^Loading…?$/)).toHaveCount(0, { timeout: 15_000 }).catch(() => undefined);
  await expect(page.locator(".animate-pulse")).toHaveCount(0, { timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(400);
}

/** Hide the current toasts so they do not sit over the screenshot (call before shot() when a toast is not the point).
 *  Hidden, not removed: removing sonner's nodes crashes React on the next toast. */
export async function dismissToasts(page: Page) {
  await page.evaluate(() => document.querySelectorAll<HTMLElement>("[data-sonner-toast]").forEach((t) => (t.style.visibility = "hidden")));
}
