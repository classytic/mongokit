/**
 * Unit tests for the vector plugin media URL policy (SSRF defense).
 *
 * Pure — no mongo, no network. Exercises the URL classifier across the
 * OWASP SSRF cheat sheet's classic literal-IP vectors plus exact-origin
 * and wildcard-host allowlist matching.
 */

import { describe, expect, it } from 'vitest';
import { isMediaUrlAllowed } from '../../src/ai/url-policy.js';

describe('isMediaUrlAllowed — default policy (no options)', () => {
  it('passes http(s) URLs through unchanged', () => {
    expect(isMediaUrlAllowed('https://cdn.example.com/a.png')).toBe(true);
    expect(isMediaUrlAllowed('http://example.com/a.png')).toBe(true);
  });

  it('passes data: URLs through', () => {
    expect(isMediaUrlAllowed('data:image/png;base64,iVBOR')).toBe(true);
  });

  it('passes base64 blobs and non-URL strings through', () => {
    expect(isMediaUrlAllowed('iVBORw0KGgo=AAAA')).toBe(true);
    expect(isMediaUrlAllowed('/local/path/image.png')).toBe(true);
    expect(isMediaUrlAllowed('s3://bucket/key.png')).toBe(true);
  });

  it('rejects empty strings / non-strings', () => {
    expect(isMediaUrlAllowed('')).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(isMediaUrlAllowed(null as any)).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(isMediaUrlAllowed(undefined as any)).toBe(false);
  });
});

describe('isMediaUrlAllowed — blockPrivateIpUrls: true', () => {
  const policy = { blockPrivateIpUrls: true };

  it('rejects AWS/GCP metadata IP', () => {
    expect(isMediaUrlAllowed('http://169.254.169.254/latest/', policy)).toBe(false);
  });

  it('rejects loopback addresses', () => {
    expect(isMediaUrlAllowed('http://127.0.0.1/admin', policy)).toBe(false);
    expect(isMediaUrlAllowed('http://127.1.2.3/admin', policy)).toBe(false);
    expect(isMediaUrlAllowed('http://localhost:8080/', policy)).toBe(false);
    expect(isMediaUrlAllowed('http://[::1]:8080/', policy)).toBe(false);
  });

  it('rejects RFC1918 ranges', () => {
    expect(isMediaUrlAllowed('http://10.0.0.1/', policy)).toBe(false);
    expect(isMediaUrlAllowed('http://172.16.0.1/', policy)).toBe(false);
    expect(isMediaUrlAllowed('http://172.31.255.255/', policy)).toBe(false);
    expect(isMediaUrlAllowed('http://192.168.1.1/', policy)).toBe(false);
  });

  it('rejects 0.0.0.0 / CGNAT', () => {
    expect(isMediaUrlAllowed('http://0.0.0.0/', policy)).toBe(false);
    expect(isMediaUrlAllowed('http://100.64.0.1/', policy)).toBe(false);
  });

  it('accepts public IPs and real hostnames', () => {
    expect(isMediaUrlAllowed('http://8.8.8.8/', policy)).toBe(true);
    expect(isMediaUrlAllowed('https://cdn.example.com/a.png', policy)).toBe(true);
    // 172.15.x is NOT RFC1918 (RFC1918 is 172.16-31).
    expect(isMediaUrlAllowed('http://172.15.0.1/', policy)).toBe(true);
    // 172.32.x is also outside RFC1918.
    expect(isMediaUrlAllowed('http://172.32.0.1/', policy)).toBe(true);
  });

  it('rejects malformed http(s) URLs (cannot validate = cannot trust)', () => {
    expect(isMediaUrlAllowed('http://[bogus', policy)).toBe(false);
  });
});

describe('isMediaUrlAllowed — allowedOrigins allowlist', () => {
  it('exact origin match', () => {
    const policy = { allowedOrigins: ['https://cdn.example.com'] };
    expect(isMediaUrlAllowed('https://cdn.example.com/a.png', policy)).toBe(true);
    expect(isMediaUrlAllowed('https://other.example.com/a.png', policy)).toBe(false);
    expect(isMediaUrlAllowed('http://cdn.example.com/a.png', policy)).toBe(false);
  });

  it('respects port in exact origin match', () => {
    const policy = { allowedOrigins: ['https://cdn.example.com:8443'] };
    expect(isMediaUrlAllowed('https://cdn.example.com:8443/a.png', policy)).toBe(true);
    expect(isMediaUrlAllowed('https://cdn.example.com/a.png', policy)).toBe(false);
  });

  it('wildcard subdomain match', () => {
    const policy = { allowedOrigins: ['https://*.example.com'] };
    expect(isMediaUrlAllowed('https://cdn.example.com/a', policy)).toBe(true);
    expect(isMediaUrlAllowed('https://a.b.example.com/a', policy)).toBe(true);
    expect(isMediaUrlAllowed('https://example.com/a', policy)).toBe(false); // no subdomain
    expect(isMediaUrlAllowed('https://badexample.com/a', policy)).toBe(false);
    expect(isMediaUrlAllowed('https://evil.com/?v=example.com', policy)).toBe(false);
  });

  it('wildcard match locks the protocol', () => {
    const policy = { allowedOrigins: ['https://*.example.com'] };
    expect(isMediaUrlAllowed('http://cdn.example.com/', policy)).toBe(false);
  });

  it('supports multiple entries in the allowlist', () => {
    const policy = {
      allowedOrigins: ['https://cdn.example.com', 'https://*.trusted.net'],
    };
    expect(isMediaUrlAllowed('https://cdn.example.com/', policy)).toBe(true);
    expect(isMediaUrlAllowed('https://a.trusted.net/', policy)).toBe(true);
    expect(isMediaUrlAllowed('https://not-trusted.net/', policy)).toBe(false);
  });

  it('data: URLs are allowed regardless of origin allowlist', () => {
    const policy = { allowedOrigins: ['https://cdn.example.com'] };
    expect(isMediaUrlAllowed('data:image/png;base64,xxx', policy)).toBe(true);
  });
});

describe('isMediaUrlAllowed — combined policy', () => {
  it('blocks private IP even if it matches the allowlist', () => {
    const policy = {
      allowedOrigins: ['http://127.0.0.1'],
      blockPrivateIpUrls: true,
    };
    expect(isMediaUrlAllowed('http://127.0.0.1/', policy)).toBe(false);
  });

  it('public origin + allowlist + blockPrivateIpUrls works together', () => {
    const policy = {
      allowedOrigins: ['https://cdn.example.com'],
      blockPrivateIpUrls: true,
    };
    expect(isMediaUrlAllowed('https://cdn.example.com/', policy)).toBe(true);
    expect(isMediaUrlAllowed('http://169.254.169.254/', policy)).toBe(false);
    expect(isMediaUrlAllowed('https://other.example.com/', policy)).toBe(false);
  });
});
