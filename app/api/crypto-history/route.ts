import { NextRequest, NextResponse } from 'next/server';

const BINANCE_KLINES_URL = 'https://api.binance.us/api/v3/klines';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const symbol = searchParams.get('symbol') || 'BTCUSDT';
    const interval = searchParams.get('interval') || '1h';
    const limit = searchParams.get('limit') || '100';

    const url = `${BINANCE_KLINES_URL}?symbol=${symbol}&interval=${interval}&limit=${limit}`;

    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) {
      const text = await res.text();
      console.error('Binance klines error:', text);
      return NextResponse.json(
        { error: 'Failed to fetch history from Binance', detail: text },
        { status: 500 }
      );
    }

    const raw = await res.json();

    // Map to simplified { time, close } points
    const points = raw.map((c: any[]) => ({
      time: c[0],               // open time (ms)
      close: parseFloat(c[4]),  // close price
    }));

    return NextResponse.json({
      symbol,
      interval,
      points,
    });
  } catch (err: any) {
    console.error('Error in /api/crypto-history:', err);
    return NextResponse.json(
      { error: 'Internal server error', detail: err?.message },
      { status: 500 }
    );
  }
}