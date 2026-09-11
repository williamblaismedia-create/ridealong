import type { Page, Locator } from 'playwright';

export interface RefNode { ref: string; role: string; name: string; level: number; nth: number }

// NOTE: the installed Playwright (1.63.x, satisfying package.json's ^1.47.0) has fully
// removed `page.accessibility.snapshot()` at runtime (not just deprecated it) — see
// task-4-report.md for the diagnostic. `locator.ariaSnapshot()` is the current
// equivalent; it returns a YAML-like text tree (e.g. `- button "Go"`,
// `- listitem: alpha`, nested lines indented two spaces per level) instead of a JS
// object tree. This regex parses that text into the same RefNode shape the brief
// specifies; the public interface (RefNode, snapshotWithRefs, resolveRef) is unchanged.
const LINE_RE = /^(\s*)-\s+([A-Za-z][\w-]*)(?:\s+"([^"]*)"(?:\s*\[[^\]]*\])?|:\s*(.*))?$/;

export async function snapshotWithRefs(page: Page): Promise<{ nodes: RefNode[]; text: string }> {
  const raw = await page.locator('body').ariaSnapshot();
  const nodes: RefNode[] = [];
  const lines: string[] = [];
  const counter = new Map<string, number>();
  let seq = 0;

  for (const rawLine of raw.split('\n')) {
    if (!rawLine.trim()) continue;
    const m = LINE_RE.exec(rawLine);
    if (!m) continue;
    const [, indent, role, quotedName, colonText] = m;
    const level = Math.floor(indent.length / 2);
    const name = quotedName ?? colonText ?? '';
    const key = `${role} ${name}`;
    const nth = counter.get(key) ?? 0;
    counter.set(key, nth + 1);
    const ref = `e${++seq}`;
    nodes.push({ ref, role, name, level, nth });
    lines.push(`${'  '.repeat(level)}[${ref}] ${role}${name ? ` "${name}"` : ''}`);
  }

  return { nodes, text: lines.join('\n') };
}

export function resolveRef(page: Page, node: RefNode): Locator {
  return page.getByRole(node.role as any, node.name ? { name: node.name, exact: true } : {}).nth(node.nth);
}
