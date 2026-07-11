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
