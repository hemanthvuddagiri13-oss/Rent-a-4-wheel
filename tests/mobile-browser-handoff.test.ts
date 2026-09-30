import { describe, expect, it } from 'vitest';
import { privateBrowserUrl } from '../packages/mobile-client/src/browser-handoff';
describe('independent authenticated browser destinations', () => {
  it('constructs only fixed same-origin account locations without credentials', () => {
    expect(privateBrowserUrl('https://staging.example.test', '/account/reservations/abc_123')).toBe('https://staging.example.test/account/reservations/abc_123');
    expect(privateBrowserUrl('https://staging.example.test', '/account/reservations/abc#signed-agreement')).toBe('https://staging.example.test/account/reservations/abc#signed-agreement');
    expect(privateBrowserUrl('http://localhost:3000', '/account/reservations/abc', true)).toBe('http://localhost:3000/account/reservations/abc');
  });
  it.each(['https://evil.test', '//evil.test/path', '/account/reservations/abc?token=secret', '/account/reservations/%2e%2e', '/account/reservations/abc/../../admin', '/account/reservations/abc#access-token', '/api/documents/private'])('rejects unapproved destination %s', path => {
    expect(() => privateBrowserUrl('https://staging.example.test', path)).toThrow();
  });
  it.each(['http://staging.example.test', 'http://localhost:3000', 'https://user:secret@staging.example.test', 'https://staging.example.test/base', 'https://staging.example.test?secret=x', 'javascript:alert(1)'])('rejects invalid configured origin %s', origin => {
    expect(() => privateBrowserUrl(origin, '/account/reservations/abc')).toThrow();
  });
});
