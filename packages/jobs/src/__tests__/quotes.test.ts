import { describe, it, expect } from 'vitest';
import { MOTIVATIONAL_QUOTES, pickQuote } from '../quotes';

describe('Motivational quotes — bundled list for weekly summary (REQUIREMENTS F11.1)', () => {
  it('exposes at least 30 quotes (bundled curated list)', () => {
    expect(MOTIVATIONAL_QUOTES.length).toBeGreaterThanOrEqual(30);
  });

  it('every quote has non-empty text and author', () => {
    for (const q of MOTIVATIONAL_QUOTES) {
      expect(q.text.trim().length).toBeGreaterThan(0);
      expect(q.author.trim().length).toBeGreaterThan(0);
    }
  });

  it('pickQuote with the same seed is DETERMINISTIC (idempotent for retries)', () => {
    const a = pickQuote('user101:2026-W21');
    const b = pickQuote('user101:2026-W21');
    expect(a).toEqual(b);
  });

  it('pickQuote with different seeds may produce different quotes (uses hash distribution)', () => {
    // Sample many seeds — at least 2 distinct quotes should emerge.
    const seen = new Set(
      Array.from({ length: 30 }, (_, i) => pickQuote(`seed-${i}`).text),
    );
    expect(seen.size).toBeGreaterThan(1);
  });

  it('pickQuote without seed returns a valid quote (random fallback)', () => {
    const q = pickQuote();
    expect(q.text.length).toBeGreaterThan(0);
    expect(MOTIVATIONAL_QUOTES.some((mq) => mq.text === q.text)).toBe(true);
  });
});
