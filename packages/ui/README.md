# @harvoost/ui

Shared, accessible, Tailwind-styled UI components for `apps/web` and `apps/tray`.

## Contents

### Primitives

- `Button` — `primary | secondary | ghost | danger` × `sm | md | lg`, loading state.
- `Input` — labelled text input with optional error + hint, prefix icon support.
- `Select` — native `<select>` wrapped with consistent chrome.
- `Card` — surface container with optional title / subtitle / actions slots.
- `Table` + `THead/TBody/TR/TH/TD` + `SortableTH`.
- `Modal` (Radix Dialog) — accessible focus trap, escape-to-close.
- `Tabs` (Radix Tabs) — keyboard-navigable.
- `Badge` + `TimesheetStatusBadge` — status pills incl. the timesheet state machine.
- `Avatar` — initials-based, no external image dep.
- `MoodPicker` — five happy-face glyphs, radio-group semantics, keyboard arrows.
- `StarRating` — display-only.
- `LoadingSpinner`, `EmptyState`.
- `Toast` / `ToastProvider` / `useToast` (Radix Toast) — drop-in notification API.

### Tokens

- `harvoostColors` (TypeScript) — brand + neutral palette, exposed as hex.
- `tailwind.config.preset.cjs` — Tailwind preset extended by both apps.
- `cn()` — `clsx` + `tailwind-merge` helper.

## Consuming

```ts
import { Button, Card, MoodPicker } from '@harvoost/ui';
```

```js
// apps/web/tailwind.config.ts
const preset = require('@harvoost/ui/tailwind-preset');
module.exports = { presets: [preset], content: [...] };
```

## Design notes

- Mobile-responsive (down to 320px), but not mobile-first — Harvoost is a
  productivity tool, so the densities skew Linear/Notion-like.
- Accessibility: every interactive primitive ships with a visible focus ring,
  proper ARIA semantics, and keyboard support. The MoodPicker is a `radiogroup`;
  the Tabs / Modal use Radix primitives.
- Brand colour: teal (`brand-600` for primary actions). One brand colour, used
  sparingly.
