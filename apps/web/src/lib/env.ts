// Centralised env access. NEXT_PUBLIC_* are exposed to the browser; everything else
// is only readable server-side.

export const env = {
  API_BASE_URL:
    process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001',
  WEB_BASE_URL:
    process.env.NEXT_PUBLIC_WEB_BASE_URL ?? 'http://localhost:3000',
};
