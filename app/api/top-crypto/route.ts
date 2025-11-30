// app/api/top-crypto/route.ts
import { NextRequest, NextResponse } from 'next/server';

const BINANCE_URL = 'https://api.binance.us/api/v3/ticker/24hr';

export async function GET(_req: NextRequest) {
  try {
    const res = await fetch(BINANCE_URL, { cache: 'no-store' });
    if (!res.ok) {
      const text = await res.text();
      console.error('Binance 24hr error:', text);
      return NextResponse.json(
        { error: 'Failed to fetch tickers from Binance', detail: text },
        { status: 500 }
      );
    }

    const data = await res.json();

    // Filter to USDT pairs and drop leveraged tokens like XXXUP / XXXDOWN if you want
    const usdtPairs = (data as any[])
      .filter((d) => {
        const s = d.symbol as string;
        return (
          s.endsWith('USDT') &&
          !s.includes('UP') &&
          !s.includes('DOWN') &&
          !s.includes('BULL') &&
          !s.includes('BEAR')
        );
      })
      .sort(
        (a, b) =>
          Number(b.quoteVolume || 0) - Number(a.quoteVolume || 0)
      );

    const top25 = usdtPairs.slice(0, 25).map((d) => ({
      symbol: d.symbol,
      lastPrice: Number(d.lastPrice),
      priceChangePercent: Number(d.priceChangePercent),
      volume: Number(d.volume),
    }));

    return NextResponse.json({ coins: top25 });
  } catch (err: any) {
    console.error('Error fetching top crypto:', err);
    return NextResponse.json(
      { error: 'Failed to fetch top crypto prices', detail: err?.message },
      { status: 500 }
    );
  }
}