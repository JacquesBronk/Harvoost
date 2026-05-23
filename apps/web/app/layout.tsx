import type { Metadata } from 'next';
import './globals.css';
import { Providers } from '@/components/Providers.js';

export const metadata: Metadata = {
  title: 'Harvoost',
  description: 'Time tracking, leave, and profitability for your team.',
  applicationName: 'Harvoost',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
