import type { Page, Locator } from 'playwright';

export interface RefNode { ref: string; role: string; name: string; level: number; nth: number }

// NOTE: the installed Playwright (1.63.x, satisfying package.json's ^1.47.0) has fully
// removed `page.accessibility.snapshot()` at runtime (not just deprecated it) — see
// task-4-report.md for the diagnostic. `locator.ariaSnapshot()` is the current
// equivalent; it returns a YAML-like text tree (e.g. `- button "Go"`,
// `- listitem: alpha`, nested lines indented two spaces per level) instead of a JS
// object tree; the public interface (RefNode, snapshotWithRefs, resolveRef) is unchanged.
//
// parseAriaLine is a pure per-line parser covering the documented aria-snapshot
// grammar (https://playwright.dev/docs/aria-snapshots), after stripping the leading
// indent and the "- " bullet:
//   role                        -> { role, name: '' }
//   role "name"                 -> { role, name }
//   role [attr]                 -> { role, name: '' }     (bracketed attrs ignored)
//   role "name" [attr]          -> { role, name }
//   role "name" [attr]: value   -> { role, name }         (quoted name wins; colon value dropped)
//   role: value                 -> { role, name: value }
// Returns null only for lines with no role token at all (blank/structural lines) —
// it must never silently drop a line that clearly names a role.
export function parseAriaLine(line: string): { role: string; name: string; level: number } | null {
  const bulletMatch = /^(\s*)-\s+(.*)$/.exec(line);
  if (!bulletMatch) return null;
  const [, indent, rest] = bulletMatch;
  const level = Math.floor(indent.length / 2);

  const roleMatch = /^([^\s"\[:]+)/.exec(rest);
  if (!roleMatch) return null;
  const role = roleMatch[1];
  let remainder = rest.slice(role.length);

  let name = '';
  const nameMatch = /^\s*"([^"]*)"/.exec(remainder);
  if (nameMatch) {
    name = nameMatch[1];
    remainder = remainder.slice(nameMatch[0].length);
  }

  let attrMatch = /^\s*\[[^\]]*\]/.exec(remainder);
  while (attrMatch) {
    remainder = remainder.slice(attrMatch[0].length);
    attrMatch = /^\s*\[[^\]]*\]/.exec(remainder);
  }

  if (!name) {
    const colonMatch = /^\s*:\s*(.*)$/.exec(remainder);
    if (colonMatch) name = colonMatch[1].trim();
  }

  return { role, name, level };
}

export async function snapshotWithRefs(page: Page): Promise<{ nodes: RefNode[]; text: string }> {
  const raw = await page.locator('body').ariaSnapshot();
  const nodes: RefNode[] = [];
  const lines: string[] = [];
  const counter = new Map<string, number>();
  let seq = 0;

  for (const rawLine of raw.split('\n')) {
    const parsed = parseAriaLine(rawLine);
    if (!parsed) continue;
    const { role, name, level } = parsed;
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
