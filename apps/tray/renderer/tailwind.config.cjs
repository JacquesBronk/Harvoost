/* eslint-disable @typescript-eslint/no-require-imports */
const preset = require('@harvoost/ui/tailwind-preset');

/** @type {import('tailwindcss').Config} */
module.exports = {
  presets: [preset],
  content: [
    './index.html',
    './**/*.{ts,tsx}',
    '../../../packages/ui/src/**/*.{ts,tsx}',
  ],
};
