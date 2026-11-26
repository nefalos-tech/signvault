import { connection } from 'next/server';
import { heistConfig } from '@/lib/heist';
import { readHeist } from '@/lib/heist-chain';

/** GET /heist/state: the live tally the page polls. Closed or misconfigured, it says only that it is not open. */
export async function GET() {
  await connection();
  const cfg = heistConfig(process.env);
  if (cfg.kind !== 'open') return Response.json({ open: false });
  try {
    const read = await readHeist(cfg);
    if (!read.ok) return Response.json({ open: false });
    return Response.json({ open: true, view: read.view });
  } catch (err) {
    // The error can carry the RPC URL, which may hold an API key, so it stays in the server log.
    console.error('heist: reading the chain failed', err);
    return Response.json({ open: true, error: 'Could not read the chain just now.' }, { status: 503 });
  }
}
