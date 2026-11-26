import { afterEach, describe, expect, it, vi } from 'vitest';
import { startRun } from './hooks';

afterEach(() => vi.unstubAllGlobals());

describe('startRun', () => {
  it('posts { wallet: "signvault" } to /api/runs for "Run again on SignVault"', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ runIds: ['r1'] })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(startRun('signvault')).resolves.toEqual({ runIds: ['r1'] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/api/runs');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ wallet: 'signvault' });
  });

  it('throws with the server message when the run is refused', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('busy', { status: 409 })));
    await expect(startRun('signvault')).rejects.toThrow('/api/runs answered 409: busy');
  });
});
