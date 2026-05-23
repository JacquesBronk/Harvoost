'use client';

import { Button, Card, useToast } from '@harvoost/ui';
import { LogIn, Timer } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { apiFetch, ApiError, describeError } from '@/lib/api-client.js';
import {
  IDP_FALLBACK_NAME,
  idpButtonLabel,
  idpCardCopy,
  resolveIdpName,
  type IdpInfo,
} from '@/lib/idp-info.js';
import { OIDC_OPAQUE_STATE_KEY } from '@/lib/oidc.js';

// Shape returned by POST /v1/auth/oidc/login (see openapi.yaml).
// The backend builds the redirect_uri server-side from OIDC_REDIRECT_URI_WEB
// and returns an opaque state id we must echo back on the callback.
interface OidcLoginResponse {
  authorization_url: string;
  opaque_state_id: string;
}

export default function LoginPage() {
  const router = useRouter();
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  // Neutral until /v1/auth/idp-info resolves — the button never blocks on it.
  const [idpName, setIdpName] = useState(IDP_FALLBACK_NAME);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Public / unauthenticated endpoint (ADR-0001). connect-src already
        // allows the API origin (INC-001 CSP). A failure here is non-fatal:
        // we keep the neutral fallback copy and the button stays usable.
        const info = await apiFetch<IdpInfo>('/v1/auth/idp-info', { token: null });
        if (!cancelled) setIdpName(resolveIdpName(info));
      } catch {
        // Swallow — neutral copy already shown; sign-in still works.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSignIn() {
    setLoading(true);
    try {
      // The backend ignores any client-sent redirect_uri and builds it
      // server-side; we send only the client_kind discriminator (LoginInitSchema).
      const resp = await apiFetch<OidcLoginResponse>('/v1/auth/oidc/login', {
        method: 'POST',
        body: { client_kind: 'web' },
      });
      // Persist the opaque state so the callback page can return it to satisfy
      // OidcCallbackSchema (which requires opaque_state_id).
      sessionStorage.setItem(OIDC_OPAQUE_STATE_KEY, resp.opaque_state_id);
      // Hand off to the IdP for the authorization handshake (top-level nav).
      window.location.assign(resp.authorization_url);
    } catch (err) {
      setLoading(false);
      if (err instanceof ApiError && err.status === 0) {
        toast.error(
          'Cannot reach the API',
          'Make sure the Harvoost API is running at the configured base URL.',
        );
      } else {
        toast.error('Sign-in failed', describeError(err));
      }
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-50 px-4">
      <Card className="w-full max-w-md" padded>
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-600 text-white">
            <Timer className="h-5 w-5" aria-hidden="true" />
          </div>
          <h1 className="text-xl font-semibold text-neutral-900">Sign in to Harvoost</h1>
          <p className="max-w-xs text-sm text-neutral-500">{idpCardCopy(idpName)}</p>
          <Button
            variant="primary"
            size="lg"
            iconLeft={<LogIn className="h-4 w-4" aria-hidden="true" />}
            loading={loading}
            onClick={handleSignIn}
            className="mt-2 w-full"
          >
            {idpButtonLabel(idpName)}
          </Button>
          <button
            type="button"
            onClick={() => router.refresh()}
            className="mt-1 text-xs text-neutral-500 hover:text-neutral-700"
          >
            Retry
          </button>
        </div>
      </Card>
    </div>
  );
}
