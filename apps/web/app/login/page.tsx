'use client';

import { Button, Card, useToast } from '@harvoost/ui';
import { LogIn, Timer } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiFetch, ApiError, describeError } from '@/lib/api-client.js';
import { env } from '@/lib/env.js';

// Shape returned by POST /v1/auth/oidc/login (see openapi.yaml).
interface OidcLoginResponse {
  authorization_url: string;
  state: string;
}

export default function LoginPage() {
  const router = useRouter();
  const toast = useToast();
  const [loading, setLoading] = useState(false);

  async function handleSignIn() {
    setLoading(true);
    try {
      const redirectUri = `${env.WEB_BASE_URL}/auth/callback`;
      const resp = await apiFetch<OidcLoginResponse>('/v1/auth/oidc/login', {
        method: 'POST',
        body: { redirect_uri: redirectUri },
      });
      // Hand off to Entra ID for the authorization handshake.
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
          <p className="max-w-xs text-sm text-neutral-500">
            Use your work account. Authentication is handled by Microsoft Entra ID; MFA
            is enforced through your organisation&apos;s policy.
          </p>
          <Button
            variant="primary"
            size="lg"
            iconLeft={<LogIn className="h-4 w-4" aria-hidden="true" />}
            loading={loading}
            onClick={handleSignIn}
            className="mt-2 w-full"
          >
            Continue with Microsoft
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
