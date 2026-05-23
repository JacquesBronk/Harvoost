import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Avatar, initialsOf } from '@harvoost/ui';

/**
 * INC-002 — a missing display_name from GET /v1/auth/me must never crash the
 * AppShell. The Avatar previously called `name.trim()` unguarded, throwing
 * "Cannot read properties of undefined (reading 'trim')" on render. These
 * tests pin the defense-in-depth: Avatar renders for any name input and
 * degrades to a sensible fallback rather than throwing.
 */
describe('Avatar (INC-002 missing-name resilience)', () => {
  it('initialsOf never throws and returns "?" for missing/empty names', () => {
    expect(initialsOf(undefined)).toBe('?');
    expect(initialsOf(null)).toBe('?');
    expect(initialsOf('')).toBe('?');
    expect(initialsOf('   ')).toBe('?');
  });

  it('initialsOf derives initials from real names', () => {
    expect(initialsOf('Ada')).toBe('A');
    expect(initialsOf('Ada Lovelace')).toBe('AL');
    expect(initialsOf('  Grace  Brewster  Hopper ')).toBe('GH');
  });

  it.each([undefined, null, '', '   ', 'Ada Lovelace'])(
    'renders without throwing for name=%j',
    (name) => {
      // @ts-expect-error — exercising the runtime path that previously crashed.
      expect(() => renderToStaticMarkup(createElement(Avatar, { name }))).not.toThrow();
    },
  );

  it('falls back to a non-empty accessible label when name is missing', () => {
    const html = renderToStaticMarkup(createElement(Avatar, { name: undefined }));
    // The crashing initials are replaced by the fallback glyph...
    expect(html).toContain('?');
    // ...and the avatar still exposes a non-empty aria-label.
    expect(html).toMatch(/aria-label="User"/);
  });

  it('uses the provided name for the accessible label when present', () => {
    const html = renderToStaticMarkup(createElement(Avatar, { name: 'Ada Lovelace' }));
    expect(html).toContain('AL');
    expect(html).toMatch(/aria-label="Ada Lovelace"/);
  });
});
