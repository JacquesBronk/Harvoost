import { describe, it, expect } from 'vitest';
import {
  IDP_FALLBACK_NAME,
  idpButtonLabel,
  idpCardCopy,
  resolveIdpName,
} from './idp-info.js';

/**
 * INC-002 / ADR-0001 — the login copy must be IdP-agnostic.
 *
 * The login page derives its card copy + button label from the display_name
 * returned by GET /v1/auth/idp-info, falling back to a neutral label until the
 * endpoint resolves (or if it errors). These tests pin the copy-derivation so
 * the page can never regress to a hardcoded provider name.
 */
describe('idp-info copy (ADR-0001 provider-agnostic login)', () => {
  it('falls back to a neutral label when no idp-info is available', () => {
    expect(resolveIdpName(null)).toBe(IDP_FALLBACK_NAME);
    expect(resolveIdpName(undefined)).toBe(IDP_FALLBACK_NAME);
    expect(resolveIdpName({ display_name: '', issuer: 'x' })).toBe(IDP_FALLBACK_NAME);
    expect(resolveIdpName({ display_name: '   ', issuer: 'x' })).toBe(IDP_FALLBACK_NAME);
  });

  it('uses (trimmed) display_name when the endpoint returns one', () => {
    expect(
      resolveIdpName({ display_name: 'Keycloak (dev)', issuer: 'http://kc/realms/h' }),
    ).toBe('Keycloak (dev)');
    expect(
      resolveIdpName({ display_name: '  Microsoft Entra ID  ', issuer: 'https://login' }),
    ).toBe('Microsoft Entra ID');
  });

  it('renders the resolved IdP name in the card copy and button label', () => {
    const name = resolveIdpName({ display_name: 'Keycloak (dev)', issuer: 'http://kc' });
    expect(idpButtonLabel(name)).toBe('Continue with Keycloak (dev)');
    expect(idpCardCopy(name)).toContain('Keycloak (dev)');
    expect(idpCardCopy(name)).toContain('Authentication is handled by');
  });

  it('never hardcodes "Microsoft" in the fallback copy', () => {
    const fallbackButton = idpButtonLabel(IDP_FALLBACK_NAME);
    const fallbackCopy = idpCardCopy(IDP_FALLBACK_NAME);
    expect(fallbackButton).toBe('Continue with your identity provider');
    expect(fallbackButton).not.toMatch(/microsoft/i);
    expect(fallbackCopy).not.toMatch(/microsoft/i);
  });

  it('reflects whatever display_name the endpoint provides (Entra in prod)', () => {
    // When prod points OIDC_ISSUER_URL at Entra, idp-info returns the Entra
    // display name and the button reflects it — no code change required.
    const name = resolveIdpName({
      display_name: 'Microsoft Entra ID',
      issuer: 'https://login.microsoftonline.com/<tenant>/v2.0',
    });
    expect(idpButtonLabel(name)).toBe('Continue with Microsoft Entra ID');
  });
});
