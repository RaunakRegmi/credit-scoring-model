'use client';

import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * TanStack Query provider.
 *
 * The client is created in state rather than at module scope so each browser session gets its
 * own cache. A module-level client is shared across requests during server rendering, which
 * would leak one applicant's cached assessment into another's page.
 */
export function Providers({ children }: { readonly children: React.ReactNode }): React.ReactElement {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Financial assessments are point-in-time records; refetching on focus would
            // silently replace what an underwriter is reading.
            refetchOnWindowFocus: false,
            staleTime: 60_000,
            retry: 1,
          },
          mutations: {
            // Never auto-retry an assessment. It writes an immutable audit record (§10.4), and
            // a duplicate submission produces two decisions for one application.
            retry: 0,
          },
        },
      }),
  );

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
