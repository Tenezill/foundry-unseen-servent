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

/**
 * M23 custom-item chain (Task 0 findings §Headline plan amendments 5, live-
 * verified): no embedded-create endpoint exists, so custom item creation is
 * POST /create (world item) -> POST /give (copies onto the actor) ->
 * DELETE /delete (best-effort cleanup of the scratch world item).
 */
describe('FoundryRelayClient.createWorldItem()', () => {
  let client: FoundryRelayClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new FoundryRelayClient({
      baseUrl: 'http://relay:3010',
      apiKey: 'test-api-key',
      clientId: 'fvtt_test123',
    });
  });

  it('POSTs /create with {entityType, data} and returns body.uuid', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValueOnce({ uuid: 'Item.abc123', entity: { _id: 'abc123' } }),
      text: vi.fn(),
    });

    const data = { name: 'Stake', type: 'weapon', system: { weaponvalue: 2 } };
    const result = await client.createWorldItem(data);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/create');
    expect(url).toContain('clientId=fvtt_test123');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('test-api-key');
    expect(JSON.parse(init.body as string)).toEqual({ entityType: 'Item', data });
    expect(result).toBe('Item.abc123');
  });

  it('falls back to "Item." + entity._id when body.uuid is absent', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValueOnce({ entity: { _id: 'abc123' } }),
      text: vi.fn(),
    });
    const result = await client.createWorldItem({ name: 'Stake', type: 'weapon', system: {} });
    expect(result).toBe('Item.abc123');
  });

  it('returns null when the relay responds with neither uuid nor entity._id', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValueOnce({}),
      text: vi.fn(),
    });
    const result = await client.createWorldItem({ name: 'Stake', type: 'weapon', system: {} });
    expect(result).toBeNull();
  });

  it('returns null on an HTTP failure (never throws)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: vi.fn(),
      text: vi.fn().mockResolvedValueOnce('boom'),
    });
    const result = await client.createWorldItem({ name: 'Stake', type: 'weapon', system: {} });
    expect(result).toBeNull();
  });

  it('returns null when the relay is unreachable (never throws)', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));
    const result = await client.createWorldItem({ name: 'Stake', type: 'weapon', system: {} });
    expect(result).toBeNull();
  });
});

describe('FoundryRelayClient.giveItem()', () => {
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

  it('POSTs /give with {toUuid, itemUuid} and returns true on success', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValueOnce({ success: true }),
      text: vi.fn(),
    });

    const result = await client.giveItem('Actor.a1', 'Item.abc123');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/give');
    expect(url).toContain('clientId=fvtt_test123');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('test-api-key');
    expect(JSON.parse(init.body as string)).toEqual({ toUuid: 'Actor.a1', itemUuid: 'Item.abc123' });
    expect(result).toBe(true);
  });

  it('returns false (no throw) when the relay body lacks success:true', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValueOnce({ error: 'nope' }),
      text: vi.fn(),
    });
    const result = await client.giveItem('Actor.a1', 'Item.abc123');
    expect(result).toBe(false);
  });

  it('returns false (no throw) on an HTTP failure, and logs a warning', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: vi.fn(),
      text: vi.fn().mockResolvedValueOnce('boom'),
    });
    const result = await client.giveItem('Actor.a1', 'Item.abc123');
    expect(result).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('returns false (no throw) when the relay is unreachable', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));
    const result = await client.giveItem('Actor.a1', 'Item.abc123');
    expect(result).toBe(false);
  });
});

describe('FoundryRelayClient.deleteEntity()', () => {
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

  it('DELETEs /delete?uuid=… with clientId + api-key', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValueOnce({}),
      text: vi.fn(),
    });

    const result = await client.deleteEntity('Item.abc123');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/delete');
    expect(url).toContain('uuid=Item.abc123');
    expect(url).toContain('clientId=fvtt_test123');
    expect(init.method).toBe('DELETE');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('test-api-key');
    expect(warn).not.toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it('returns false (no throw) on an HTTP failure, and logs a warning', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: vi.fn(),
      text: vi.fn().mockResolvedValueOnce('boom'),
    });
    const result = await client.deleteEntity('Item.abc123');
    expect(result).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('returns false (no throw) when the relay is unreachable, and logs a warning', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));
    const result = await client.deleteEntity('Item.abc123');
    expect(result).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('returns false (no throw) on an applicative {error} response, and logs a warning', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValueOnce({ error: 'no such entity' }),
      text: vi.fn(),
    });
    const result = await client.deleteEntity('Item.abc123');
    expect(result).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('FoundryRelayClient.castAtSlot()', () => {
  let client: FoundryRelayClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new FoundryRelayClient({
      baseUrl: 'http://relay:3010',
      apiKey: 'test-api-key',
      clientId: 'fvtt_test123',
    });
  });

  it('rejects malformed uuids and slot keys before any network call', async () => {
    await expect(client.castAtSlot('Actor.abc; drop', 'Actor.abc123.Item.def456', 'spell3')).rejects.toThrow(/actorUuid/);
    await expect(client.castAtSlot('Actor.abc123', 'Actor.abc123.Item.x"y', 'spell3')).rejects.toThrow(/itemUuid/);
    await expect(client.castAtSlot('Actor.abc123', 'Actor.abc123.Item.def456', 'pact')).rejects.toThrow(/slotKey/);
    await expect(client.castAtSlot('Actor.abc123', 'Actor.abc123.Item.def456', 'spell1')).rejects.toThrow(/slotKey/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('POSTs /execute-js with a script containing the quoted item uuid and slot key, and returns the roll', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValueOnce({
        success: true,
        result: { roll: { total: 18, formula: '1d20 + 7' } },
      }),
      text: vi.fn(),
    });

    const res = await client.castAtSlot('Actor.abc123', 'Actor.abc123.Item.def456', 'spell3');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/execute-js');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('test-api-key');
    const body = JSON.parse(init.body as string) as { script: string };
    expect(body.script).toContain(JSON.stringify('Actor.abc123.Item.def456'));
    expect(body.script).toContain(JSON.stringify('spell3'));
    // Every occurrence of the caller-controlled uuid is inside a quoted
    // JSON.stringify literal — never spliced in raw/unquoted.
    const rawUuidPattern = /(?<!")Actor\.abc123\.Item\.def456(?!")/g;
    expect(body.script.match(rawUuidPattern)).toBeNull();
    expect(res).toEqual({ roll: { total: 18, formula: '1d20 + 7' } });
  });

  it('returns body.result ?? body when result is not an object (defensive unwrap)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValueOnce({ success: true }),
      text: vi.fn(),
    });

    const res = await client.castAtSlot('Actor.abc123', 'Actor.abc123.Item.def456', 'spell3');
    expect(res).toEqual({ success: true });
  });

  it('rejects with a RelayError carrying the error text when the 200 body reports execute-js disabled', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValueOnce({
        success: false,
        error: 'execute-js is disabled in REST API module settings',
      }),
      text: vi.fn(),
    });

    await expect(client.castAtSlot('Actor.abc123', 'Actor.abc123.Item.def456', 'spell3')).rejects.toThrow(
      /execute-js is disabled in REST API module settings/,
    );
  });

  it('rejects when the 200 body reports success: false with no error text', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValueOnce({ success: false }),
      text: vi.fn(),
    });

    await expect(client.castAtSlot('Actor.abc123', 'Actor.abc123.Item.def456', 'spell3')).rejects.toThrow(
      /reported failure/,
    );
  });

  it('suppresses headless template placement (create.measuredTemplate false in the script)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValueOnce({ success: true, result: {} }),
      text: vi.fn(),
    });
    await client.castAtSlot('Actor.abc123', 'Actor.abc123.Item.def456', 'spell3');
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { script: string };
    expect(body.script).toContain('create: { measuredTemplate: false }');
  });
});

describe('FoundryRelayClient.useWithoutTemplate()', () => {
  let client: FoundryRelayClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new FoundryRelayClient({
      baseUrl: 'http://relay:3010',
      apiKey: 'test-api-key',
      clientId: 'fvtt_test123',
    });
  });

  it('rejects malformed uuids before any network call', async () => {
    await expect(client.useWithoutTemplate('Actor.abc; drop', 'Actor.abc123.Item.def456')).rejects.toThrow(/actorUuid/);
    await expect(client.useWithoutTemplate('Actor.abc123', 'Actor.abc123.Item.x"y')).rejects.toThrow(/itemUuid/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('POSTs /execute-js with default consumption (no slot/consume override) and template suppression', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValueOnce({
        success: true,
        result: { roll: { total: 18, formula: '1d20 + 7' } },
      }),
      text: vi.fn(),
    });

    const res = await client.useWithoutTemplate('Actor.abc123', 'Actor.abc123.Item.def456');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/execute-js');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as { script: string };
    expect(body.script).toContain(JSON.stringify('Actor.abc123.Item.def456'));
    expect(body.script).toContain('create: { measuredTemplate: false }');
    // Default consumption: dnd5e picks the slot/uses itself.
    expect(body.script).not.toContain('spell:');
    expect(body.script).not.toContain('consume:');
    // Caller-controlled uuid never appears outside a quoted literal.
    const rawUuidPattern = /(?<!")Actor\.abc123\.Item\.def456(?!")/g;
    expect(body.script.match(rawUuidPattern)).toBeNull();
    expect(res).toEqual({ roll: { total: 18, formula: '1d20 + 7' } });
  });

  it('rejects with a RelayError carrying the error text when the 200 body reports execute-js disabled', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValueOnce({
        success: false,
        error: 'execute-js is disabled in REST API module settings',
      }),
      text: vi.fn(),
    });
    await expect(client.useWithoutTemplate('Actor.abc123', 'Actor.abc123.Item.def456')).rejects.toThrow(
      /execute-js is disabled/,
    );
  });

  it('rejects when the 200 body reports success: false with no error text', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValueOnce({ success: false }),
      text: vi.fn(),
    });
    await expect(client.useWithoutTemplate('Actor.abc123', 'Actor.abc123.Item.def456')).rejects.toThrow(
      /reported failure/,
    );
  });
});

describe('FoundryRelayClient.applyEffect()', () => {
  let client: FoundryRelayClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new FoundryRelayClient({
      baseUrl: 'http://relay:3010',
      apiKey: 'test-api-key',
      clientId: 'fvtt_test123',
    });
  });

  it('PUTs /update with the actor uuid in the query and an effects-upsert body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValueOnce({}),
      text: vi.fn(),
    });

    const effect = { _id: 'aeXXXXXXXXXXXXXX', name: 'Shield', changes: [] };
    await client.applyEffect('Actor.abc123', effect);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/update');
    expect(url).toContain('uuid=Actor.abc123');
    expect(url).toContain('clientId=fvtt_test123');
    expect(init.method).toBe('PUT');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('test-api-key');
    expect(JSON.parse(init.body as string)).toEqual({ data: { effects: [effect] } });
  });
});

describe('FoundryRelayClient — provider-based credentials (turnkey)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('re-reads apiKey and clientId providers on every request', async () => {
    let apiKey = 'key-A';
    let clientId = 'fvtt_A';
    const client = new FoundryRelayClient({
      baseUrl: 'http://relay:3010',
      apiKey: () => apiKey,
      clientId: () => clientId,
    });
    const ok = () => ({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ total: 0, clients: [] }), text: vi.fn() });
    mockFetch.mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok());

    await client.listClients();
    apiKey = 'key-B';
    clientId = 'fvtt_B';
    await client.listClients();

    const [url1, init1] = mockFetch.mock.calls[0] as [string, Record<string, unknown>];
    const [url2, init2] = mockFetch.mock.calls[1] as [string, Record<string, unknown>];
    expect((init1.headers as Record<string, string>)['x-api-key']).toBe('key-A');
    expect((init2.headers as Record<string, string>)['x-api-key']).toBe('key-B');
    expect(url1).toContain('clientId=fvtt_A');
    expect(url2).toContain('clientId=fvtt_B');
  });

  it('an unresolved clientId provider ("") still issues the request with an empty param', async () => {
    const client = new FoundryRelayClient({
      baseUrl: 'http://relay:3010',
      apiKey: 'k',
      clientId: () => '',
    });
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ total: 0, clients: [] }), text: vi.fn() });
    await client.listClients();
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toContain('clientId=');
  });
});
