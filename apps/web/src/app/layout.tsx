import type { Metadata, Viewport } from 'next';

import { Providers } from './providers';

import './globals.css';

export const metadata: Metadata = {
  title: 'ONE BNPL — Credit Assessment',
  description:
    'AI-powered credit assessment for unsecured lending. Fintara Solutions Pvt Ltd, ONE BNPL.',
  // Applicant financial data is rendered here; keep it out of search indexes entirely.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
