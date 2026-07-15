import { describe, expect, it } from 'vitest';
import { loadConfig, redactUrlToken } from '../src/config.js';

describe('loadConfig', () => {
  const base = {
    RELAY_URL: 'http://relay:3010',
    RELAY_API_KEY: 'k',
    RELAY_CLIENT_ID: 'fvtt_x',
    PLAYERS_FILE: '/run/players.yaml',
  };

  it('applies defaults and reads required vars', () => {
    const cfg = loadConfig({ ...base });
    expect(cfg.port).toBe(8090);
    expect(cfg.defaultSystemId).toBe('dnd5e');
    expect(cfg.livePollMs).toBe(3000);
    expect(cfg.relayApiKey).toBe('k');
  });

  it('throws on missing required vars and bad integers', () => {
    expect(() => loadConfig({ ...base, RELAY_URL: undefined })).toThrow(/RELAY_URL/);
    expect(() => loadConfig({ ...base, PORT: 'zero' })).toThrow(/PORT/);
    expect(() => loadConfig({ ...base, PORT: '-1' })).toThrow(/PORT/);
  });

  it('accepts RELAY_API_KEY_FILE instead of RELAY_API_KEY', () => {
    const cfg = loadConfig({ ...base, RELAY_API_KEY: undefined, RELAY_API_KEY_FILE: '/run/companion/relay.env' });
    expect(cfg.relayApiKey).toBeUndefined();
    expect(cfg.relayApiKeyFile).toBe('/run/companion/relay.env');
    expect(cfg.keyBootWaitMs).toBe(15000);
  });

  it('explicit RELAY_API_KEY wins when both are set (back-compat)', () => {
    const cfg = loadConfig({ ...base, RELAY_API_KEY_FILE: '/run/companion/relay.env' });
    expect(cfg.relayApiKey).toBe('k');
    expect(cfg.relayApiKeyFile).toBeUndefined();
  });

  it('throws when neither key source is configured', () => {
    expect(() => loadConfig({ ...base, RELAY_API_KEY: undefined })).toThrow(/RELAY_API_KEY/);
  });

  it('normalizes RELAY_CLIENT_ID: unset/empty/auto -> "auto"; explicit id kept', () => {
    expect(loadConfig({ ...base, RELAY_CLIENT_ID: undefined }).relayClientId).toBe('auto');
    expect(loadConfig({ ...base, RELAY_CLIENT_ID: '' }).relayClientId).toBe('auto');
    expect(loadConfig({ ...base, RELAY_CLIENT_ID: 'auto' }).relayClientId).toBe('auto');
    expect(loadConfig({ ...base }).relayClientId).toBe('fvtt_x'); // back-compat
  });
});

describe('redactUrlToken', () => {
  it('masks the token query value wherever it appears', () => {
    expect(redactUrlToken('/api/actors/a1/events?token=sekret-123')).toBe(
      '/api/actors/a1/events?token=[redacted]',
    );
    expect(redactUrlToken('/api/actors/a1/events?foo=1&token=sekret&bar=2')).toBe(
      '/api/actors/a1/events?foo=1&token=[redacted]&bar=2',
    );
    expect(redactUrlToken('/api/me?TOKEN=sekret')).toBe('/api/me?TOKEN=[redacted]');
  });

  it('leaves token-free urls untouched', () => {
    expect(redactUrlToken('/api/me')).toBe('/api/me');
    expect(redactUrlToken('/api/x?tokenish=1')).toBe('/api/x?tokenish=1');
  });
});
