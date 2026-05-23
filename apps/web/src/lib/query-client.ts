import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api-client.js';

// One QueryClient per browser tab. Strict-mode-safe via lazy init in the provider.
export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        retry: (failureCount, err) => {
          // Don't retry hard errors (4xx) — those won't resolve on retry.
          if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
            return false;
          }
          return failureCount < 2;
        },
      },
      mutations: {
        retry: false,
      },
    },
  });
}
