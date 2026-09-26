import { afterEach, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
vi.mock('@/lib/security-request', () => ({ sharedRequestLimit: async () => true }));
import { mobileHandler } from '@/lib/mobile/http';

afterEach(() => vi.restoreAllMocks());

it.each([
  ['P2028', 'DATABASE_TRANSACTION'],
  ['P2024', 'DATABASE_POOL'],
  ['P2034', 'DATABASE_CONFLICT'],
  ['P2002', 'DATABASE_OPERATION'],
])('attributes %s without disclosing exception text, metadata or request credentials', async (code, failureKind) => {
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  const req = new Request('https://fixture.invalid/api/v1/mobile/me', { headers: { Authorization: 'Bearer private-native-credential' } });
  const response = await mobileHandler(req, 'read', async () => { throw new Prisma.PrismaClientKnownRequestError('private-query-arguments', { code, clientVersion: 'fixture', meta: { email: 'private@example.test' } }); });
  const payload = await response.json();
  expect(response.status).toBe(500);
  expect(payload).toEqual({ data: null, error: { code: 'UNAVAILABLE' }, requestId: expect.any(String) });
  expect(log).toHaveBeenCalledOnce();
  expect(JSON.parse(log.mock.calls[0][0])).toEqual({ event: 'mobile.request', timestamp: expect.any(String), operation: 'me', requestId: payload.requestId, status: 500, durationMs: expect.any(Number), failureKind });
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/private-|private@/);
});

it('distinguishes response contract failure from an unexpected exception without exposing either', async () => {
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  const req = new Request('https://fixture.invalid/api/v1/mobile/me');
  const invalid = await mobileHandler(req, 'read', async () => ({ secret: 'private-response-value' }));
  const failed = await mobileHandler(req, 'read', async () => { throw new Error('private-exception-value'); });
  expect(invalid.status).toBe(500); expect(failed.status).toBe(500);
  expect(log.mock.calls.map(call => JSON.parse(call[0]).failureKind)).toEqual(['RESPONSE_CONTRACT', 'INTERNAL']);
  expect(JSON.stringify(log.mock.calls)).not.toContain('private-');
});
