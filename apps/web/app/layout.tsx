import type { Metadata } from 'next';
import { headers } from 'next/headers';
import './globals.css';
import { Providers } from '@/components/Providers.js';

export const metadata: Metadata = {
  title: 'Harvoost',
  description: 'Time tracking, leave, and profitability for your team.',
  applicationName: 'Harvoost',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Reading headers() opts the entire route tree into dynamic rendering, so the per-request
  // CSP nonce set by middleware.ts is in scope when Next.js emits inline RSC scripts.
  // Without this, /  would stay statically prerendered and the cached HTML would have
  // nonceless <script> tags that the browser blocks under the strict CSP.
  headers();

  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
