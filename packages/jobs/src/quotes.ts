// Bundled curated motivational quote list for the weekly summary email.
// Per REQUIREMENTS.md F11.1 — "one motivational quote drawn from a bundled curated
// list (no LLM-generated quote, no external API)."
//
// Quotes are short, work-appropriate, and not religious or political.
// Attribution is included where known; "Unknown" otherwise.

export interface Quote {
  text: string;
  author: string;
}

export const MOTIVATIONAL_QUOTES: ReadonlyArray<Quote> = [
  { text: 'The way to get started is to quit talking and begin doing.', author: 'Walt Disney' },
  { text: "Don't watch the clock; do what it does. Keep going.", author: 'Sam Levenson' },
  { text: 'Quality is not an act, it is a habit.', author: 'Aristotle' },
  { text: 'Make each day your masterpiece.', author: 'John Wooden' },
  { text: 'The future depends on what you do today.', author: 'Mahatma Gandhi' },
  { text: 'Success is the sum of small efforts repeated day in and day out.', author: 'Robert Collier' },
  { text: 'Do what you can with what you have where you are.', author: 'Theodore Roosevelt' },
  { text: 'Action is the foundational key to all success.', author: 'Pablo Picasso' },
  { text: 'Well done is better than well said.', author: 'Benjamin Franklin' },
  { text: "It always seems impossible until it's done.", author: 'Nelson Mandela' },
  { text: 'Start where you are. Use what you have. Do what you can.', author: 'Arthur Ashe' },
  { text: 'The best way out is always through.', author: 'Robert Frost' },
  { text: 'Either you run the day, or the day runs you.', author: 'Jim Rohn' },
  { text: "What we think, we become.", author: 'Buddha' },
  { text: "Believe you can and you're halfway there.", author: 'Theodore Roosevelt' },
  { text: 'A goal without a plan is just a wish.', author: 'Antoine de Saint-Exupéry' },
  { text: 'Discipline is the bridge between goals and accomplishment.', author: 'Jim Rohn' },
  { text: 'The harder you work for something, the greater you’ll feel when you achieve it.', author: 'Unknown' },
  { text: 'Small daily improvements over time lead to stunning results.', author: 'Robin Sharma' },
  { text: 'You don’t have to be great to start, but you have to start to be great.', author: 'Zig Ziglar' },
  { text: 'Energy and persistence conquer all things.', author: 'Benjamin Franklin' },
  { text: "Don't be afraid to give up the good to go for the great.", author: 'John D. Rockefeller' },
  { text: 'Focus on being productive instead of busy.', author: 'Tim Ferriss' },
  { text: 'Whatever you are, be a good one.', author: 'Abraham Lincoln' },
  { text: 'A river cuts through rock not because of its power but because of its persistence.', author: 'Jim Watkins' },
  { text: 'You miss 100% of the shots you don’t take.', author: 'Wayne Gretzky' },
  { text: 'Strive not to be a success, but rather to be of value.', author: 'Albert Einstein' },
  { text: 'Hardships often prepare ordinary people for an extraordinary destiny.', author: 'C. S. Lewis' },
  { text: 'It is during our darkest moments that we must focus to see the light.', author: 'Aristotle' },
  { text: 'Do something today that your future self will thank you for.', author: 'Sean Patrick Flanery' },
];

export function pickQuote(seed?: string): Quote {
  // Deterministic per-recipient/per-week pick when a seed is provided.
  if (!seed) {
    const idx = Math.floor(Math.random() * MOTIVATIONAL_QUOTES.length);
    return MOTIVATIONAL_QUOTES[idx]!;
  }
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return MOTIVATIONAL_QUOTES[hash % MOTIVATIONAL_QUOTES.length]!;
}
