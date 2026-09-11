import { describe, it, expect } from 'vitest';
import { parseAriaLine } from '../src/refs.js';

// Focused unit test for the aria-snapshot line parser: no browser needed. Covers the
// documented grammar forms (https://playwright.dev/docs/aria-snapshots), including the
// two forms review found the old LINE_RE regex silently dropped: a bare role with a
// bracketed attribute and no name, and a quoted name followed by both an attribute and
// a colon-value.
describe('parseAriaLine', () => {
  it('parses a bare role with a quoted name', () => {
    expect(parseAriaLine('- button "Go"')).toEqual({ role: 'button', name: 'Go', level: 0 });
  });

  it('parses a quoted name with a trailing bracketed attribute', () => {
    expect(parseAriaLine('- heading "Scry Fixture" [level=1]')).toEqual({ role: 'heading', name: 'Scry Fixture', level: 0 });
  });

  it('parses a bare role with a bracketed attribute and no name', () => {
    expect(parseAriaLine('- checkbox [checked]')).toEqual({ role: 'checkbox', name: '', level: 0 });
  });

  it('parses a quoted name followed by both an attribute and a colon-value, keeping the quoted name', () => {
    expect(parseAriaLine('- textbox "Email" [invalid]: not-an-email')).toEqual({ role: 'textbox', name: 'Email', level: 0 });
  });

  it('parses a colon-value as the name when there is no quoted name', () => {
    expect(parseAriaLine('- paragraph: idle')).toEqual({ role: 'paragraph', name: 'idle', level: 0 });
  });

  it('computes level from two-space indentation', () => {
    expect(parseAriaLine('  - listitem: alpha')).toEqual({ role: 'listitem', name: 'alpha', level: 1 });
  });

  it('returns null for blank or structural lines, never dropping a line with a role token', () => {
    expect(parseAriaLine('')).toBeNull();
    expect(parseAriaLine('   ')).toBeNull();
    expect(parseAriaLine('- separator')).toEqual({ role: 'separator', name: '', level: 0 });
  });
});
