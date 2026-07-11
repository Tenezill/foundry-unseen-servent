import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FoundryRelayClient, RelayEncounter } from '../src/index.js';

// Mock fetch globally
const mockFetch = vi.fn();
(globalThis as unknown as Record<string, unknown>).fetch = mockFetch;

describe('FoundryRelayClient.getEncounters()', () => {
  let client: FoundryRelayClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new FoundryRelayClient({
      baseUrl: 'http://relay:3010',
      apiKey: 'test-api-key',
      clientId: 'fvtt_test123',
    });
  });

  it('fetches encounters from GET /encounters with clientId param and api-key header', async () => {
    const mockEncounters: RelayEncounter[] = [
      {
        id: 'combat1',
        name: 'Test Combat',
        round: 2,
        turn: 1,
        current: true,
        combatants: [
          {
            id: 'comb1',
            name: 'Enemy',
            initiative: 15,
            hidden: false,
            defeated: false,
          },
        ],
      },
    ];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValueOnce({
        type: 'encounters-result',
        requestId: 'enc_123',
        encounters: mockEncounters,
      }),
      text: vi.fn(),
    });

    const result = await client.getEncounters();

    expect(mockFetch).toHaveBeenCalledOnce();
    const calls = mockFetch.mock.calls;
    if (!calls || calls.length === 0) throw new Error('No calls made');
    const [url, init] = calls[0] as [string, Record<string, unknown>];
    expect(url).toContain('/encounters');
    expect(url).toContain('clientId=fvtt_test123');
    expect((init.method as string)).toBe('GET');
    expect(((init.headers as Record<string, string>)['x-api-key'])).toBe('test-api-key');
    expect(result).toEqual(mockEncounters);
  });

  it('returns empty array when encounters field is missing', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValueOnce({
        type: 'encounters-result',
        requestId: 'enc_123',
      }),
      text: vi.fn(),
    });

    const result = await client.getEncounters();

    expect(result).toEqual([]);
  });

  it('returns empty array when encounters field is null', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValueOnce({
        type: 'encounters-result',
        requestId: 'enc_123',
        encounters: null,
      }),
      text: vi.fn(),
    });

    const result = await client.getEncounters();

    expect(result).toEqual([]);
  });
});

/**
 * M22 cache-swap bug: live-verified against the dev relay (25 rounds of 2
 * truly-concurrent GET /get calls -> 14/50 responses came back with BOTH the
 * envelope `uuid` and the document's own `_id` belonging to the OTHER,
 * concurrently-requested actor — a relay-side request/response cross-wire,
 * not a client bug. getEntity must not trust a response's identity; it must
 * check it against what was actually requested and degrade (null) on any
 * mismatch, exactly like a timeout/failure.
 */
describe('FoundryRelayClient.getEntity() — cross-wired response rejection', () => {
  let client: FoundryRelayClient;
  let warn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    warn = vi.fn();
    client = new FoundryRelayClient({
      baseUrl: 'http://relay:3010',
      apiKey: 'test-api-key',
      clientId: 'fvtt_test123',
      log: { warn },
    });
  });

  function mockGetResponse(body: Record<string, unknown>): void {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValueOnce(body),
      text: vi.fn(),
    });
  }

  it('returns the document when envelope uuid and doc._id both match the request', async () => {
    mockGetResponse({
      type: 'entity-result',
      requestId: 'entity_1',
      uuid: 'Actor.zteTG9PZZ6XQpQtK',
      data: { _id: 'zteTG9PZZ6XQpQtK', name: 'Randal', type: 'character', system: {} },
    });
    const doc = await client.getEntity('Actor.zteTG9PZZ6XQpQtK');
    expect(doc?.name).toBe('Randal');
    expect(warn).not.toHaveBeenCalled();
  });

  it('rejects (null) when the envelope uuid AND doc._id both belong to a different, concurrently-requested actor', async () => {
    // Exact live-captured shape: requested Akra, relay handed back Randal's
    // full envelope+doc.
    mockGetResponse({
      type: 'entity-result',
      requestId: 'entity_2',
      uuid: 'Actor.zteTG9PZZ6XQpQtK',
      data: { _id: 'zteTG9PZZ6XQpQtK', name: 'Randal (Human Fighter)', type: 'character', system: {} },
    });
    const doc = await client.getEntity('Actor.pTvtx5dm2AuYqeX2');
    expect(doc).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    const [obj, msg] = warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(msg).toContain('cross-wired');
    expect(obj.requestedUuid).toBe('Actor.pTvtx5dm2AuYqeX2');
    expect(obj.docId).toBe('zteTG9PZZ6XQpQtK');
  });

  it('rejects (null) when only the envelope uuid mismatches (doc lacks _id)', async () => {
    mockGetResponse({
      type: 'entity-result',
      requestId: 'entity_3',
      uuid: 'Actor.other',
      data: { name: 'Weird', system: {} },
    });
    const doc = await client.getEntity('Actor.zteTG9PZZ6XQpQtK');
    expect(doc).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('rejects (null) when only doc._id mismatches (no envelope uuid field)', async () => {
    mockGetResponse({ data: { _id: 'wrong-id', name: 'Weird', system: {} } });
    const doc = await client.getEntity('Actor.zteTG9PZZ6XQpQtK');
    expect(doc).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('accepts a bare-document response (older relay, no envelope uuid) whose _id matches', async () => {
    mockGetResponse({ _id: 'zteTG9PZZ6XQpQtK', name: 'Randal', type: 'character', system: {} });
    const doc = await client.getEntity('Actor.zteTG9PZZ6XQpQtK');
    expect(doc?.name).toBe('Randal');
    expect(warn).not.toHaveBeenCalled();
  });

  it('still returns null (no warn) on a genuine 404, unrelated to identity checks', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: vi.fn(),
      text: vi.fn().mockResolvedValueOnce('not found'),
    });
    const doc = await client.getEntity('Actor.nope');
    expect(doc).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});
