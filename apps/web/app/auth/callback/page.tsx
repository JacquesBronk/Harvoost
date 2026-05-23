'use client';

import { LoadingSpinner, useToast } from '@harvoost/ui';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect } from 'react';
import { apiFetch, describeError } from '@/lib/api-client.js';
import { OIDC_OPAQUE_STATE_KEY } from '@/lib/oidc.js';

function CallbackInner() {
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();

  useEffect(() => {
    const code = params.get('code');
    const state = params.get('state');
    const error = params.get('error');
    if (error) {
      toast.error('Sign-in failed', params.get('error_description') ?? error);
      router.replace('/login');
      return;
    }
    if (!code || !state) {
      toast.error('Sign-in failed', 'The provider response was missing required parameters.');
      router.replace('/login');
      return;
    }
    // The opaque state id was stashed by the /login leg before the IdP hand-off.
    // The backend's OidcCallbackSchema requires it; if it is missing (e.g. the
    // user opened this URL directly, or sessionStorage was cleared mid-flow) we
    // fail gracefully rather than POST an undefined value.
    const opaqueStateId = sessionStorage.getItem(OIDC_OPAQUE_STATE_KEY);
    if (!opaqueStateId) {
      toast.error(
        'Sign-in failed',
        'Your sign-in session expired or could not be verified. Please try again.',
      );
      router.replace('/login');
      return;
    }
    // Single-use: clear it now so a stale value can't be replayed on a retry.
    sessionStorage.removeItem(OIDC_OPAQUE_STATE_KEY);
    let cancelled = false;
    (async () => {
      try {
        await apiFetch('/v1/auth/oidc/callback', {
          method: 'POST',
          body: { code, state, opaque_state_id: opaqueStateId },
          // No bearer yet — this is the call that mints the session.
          // Backend sets the HttpOnly session cookie via Set-Cookie.
          token: null,
        });
        if (cancelled) return;
        router.replace('/timesheets');
      } catch (err) {
        if (!cancelled) {
          toast.error('Sign-in failed', describeError(err));
          router.replace('/login');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // toast is stable from ToastProvider; depending on it would re-fire the effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, router]);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <LoadingSpinner size="lg" label="Completing sign-in" />
    </div>
  );
}

export default function CallbackPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <LoadingSpinner size="lg" label="Completing sign-in" />
        </div>
      }
    >
      <CallbackInner />
    </Suspense>
  );
}
