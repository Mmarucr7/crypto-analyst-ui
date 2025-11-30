'use client';

import { FormEvent, useEffect, useState } from 'react';
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { signInWithEmail, signUpWithEmail, confirmSignUp } from '../lib/cognitoClient';

// Map of SYMBOL -> Nice Name
const CRYPTO_NAME_MAP: Record<string, string> = {
  BTCUSDT: 'Bitcoin',
  ETHUSDT: 'Ethereum',
  BNBUSDT: 'Binance Coin',
  SOLUSDT: 'Solana',
  XRPUSDT: 'XRP',
  ADAUSDT: 'Cardano',
  DOGEUSDT: 'Dogecoin',
  AVAXUSDT: 'Avalanche',
  DOTUSDT: 'Polkadot',
  TRXUSDT: 'TRON',
  MATICUSDT: 'Polygon',
  LTCUSDT: 'Litecoin',
  UNIUSDT: 'Uniswap',
  LINKUSDT: 'Chainlink',
  ATOMUSDT: 'Cosmos',
  XLMUSDT: 'Stellar',
  OPUSDT: 'Optimism',
  INJUSDT: 'Injective',
  APTUSDT: 'Aptos',
  NEARUSDT: 'Near Protocol',
  ETCUSDT: 'Ethereum Classic',
  FILUSDT: 'Filecoin',
  SUIUSDT: 'Sui',
  ARBUSDT: 'Arbitrum',
  PEPEUSDT: 'PEPE',
};

const FORECAST_TABS: { key: string; label: string }[] = [
  { key: '1_week', label: '1 week' },
  { key: '1_month', label: '1 month' },
  { key: '3_months', label: '3 months' },
  { key: '6_months', label: '6 months' },
  { key: '12_months', label: '12 months' },
  { key: '5_years', label: '5 years' },
];

interface MarketSnapshot {
  exchange?: string;
  symbol?: string;
  current_price_usd?: number | null;
  price_change_percentage_24h?: number | null;
  market_cap_usd?: number | null;
}

interface PredictionResponse {
  status: string;
  s3_key?: string;
  prediction?: any;
  error?: string;
  message?: string;
}

interface TopCoin {
  symbol: string;
  lastPrice: number;
  priceChangePercent: number;
  volume: number;
}

interface HistoryPoint {
  time: number;
  close: number;
}

// ----------------- helpers -----------------
const formatNumber = (
  value: number | null | undefined,
  decimals = 2
): string => {
  if (value === null || value === undefined || Number.isNaN(value)) return 'N/A';
  return value.toFixed(decimals);
};

const formatMarketCap = (value: number | null | undefined): string => {
  if (value === null || value === undefined || Number.isNaN(value)) return 'N/A';
  if (value >= 1_000_000_000)
    return (value / 1_000_000_000).toFixed(2) + ' B';
  if (value >= 1_000_000)
    return (value / 1_000_000).toFixed(2) + ' M';
  return value.toFixed(0);
};

const getRecommendationColor = (rec?: string): string => {
  if (!rec) return '#6b7280';
  const upper = rec.toUpperCase();
  if (upper === 'BUY') return '#22c55e'; // green
  if (upper === 'SELL') return '#3b82f6'; // blue
  if (upper === 'HOLD') return '#ef4444'; // red
  return '#6b7280';
};

const getDirectionColor = (dir?: string): string => {
  if (!dir) return '#e5e7eb';
  const upper = dir.toUpperCase();
  if (upper === 'UP') return '#22c55e';
  if (upper === 'DOWN') return '#ef4444';
  if (upper === 'SIDEWAYS') return '#93c5fd';
  return '#e5e7eb';
};

export default function HomePage() {
  // ---- AUTH STATE ----
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authEmail, setAuthEmail] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [authMode, setAuthMode] = useState<'login' | 'signup' | 'confirm'>('login');
  const [authInfo, setAuthInfo] = useState<string | null>(null);
  const [pendingConfirmEmail, setPendingConfirmEmail] = useState<string | null>(null);
  const [confirmCode, setConfirmCode] = useState('');

  // ---- ANALYZER STATE ----
  const [symbol, setSymbol] = useState<string>(''); // set after top coins load

  // ---- CHAT STATE ----
  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState<
    { sender: 'user' | 'ai'; text: string }[]
  >([]);
  const [chatLoading, setChatLoading] = useState(false);

  const [chatSessionId] = useState(() => {
    if (typeof window !== 'undefined' && (window as any).crypto?.randomUUID) {
      return (window as any).crypto.randomUUID();
    }
    // fallback if randomUUID is not available
    return Math.random().toString(36).slice(2);
  });

  const [topCoins, setTopCoins] = useState<TopCoin[]>([]);
  const [topError, setTopError] = useState<string | null>(null);

  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);


  // Restore auth from localStorage on first load
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const token = localStorage.getItem('cognito_id_token');
    const email = localStorage.getItem('cognito_user_email');
    if (token) {
      setIsAuthenticated(true);
      if (email) setAuthEmail(email);
    }
  }, []);

  // Fetch top 25 USDT pairs when authenticated
  useEffect(() => {
    if (!isAuthenticated) return;

    const fetchTop = async () => {
      try {
        const res = await fetch('/api/top-crypto', { cache: 'no-store' });
        const data = await res.json();
        if (!res.ok) {
          setTopError(data.error || 'Failed to load top crypto');
        } else {
          const coins: TopCoin[] = data.coins || [];
          setTopCoins(coins);
          if (coins.length && !symbol) {
            const firstSymbol = coins[0].symbol;
            setSymbol(firstSymbol);
            setSelectedSymbol(firstSymbol);
            void loadHistory(firstSymbol);
          }
        }
      } catch (e: any) {
        setTopError(e?.message || 'Network error');
      }
    };

    void fetchTop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated]);

  // Load price history (for chart)
  const loadHistory = async (sym: string) => {
    try {
      setSelectedSymbol(sym);
      setHistory([]);
      setHistoryError(null);
      setHistoryLoading(true);

      const res = await fetch(
        `/api/crypto-history?symbol=${encodeURIComponent(sym)}&interval=1h&limit=100`,
        { cache: 'no-store' }
      );
      const data = await res.json();

      if (!res.ok) {
        setHistoryError(data.error || 'Failed to load price history');
      } else {
        setHistory(data.points || []);
      }
    } catch (e: any) {
      setHistoryError(e?.message || 'Network error');
    } finally {
      setHistoryLoading(false);
    }
  };

  // Chatbot handler – talks directly to the Bedrock Agent (Finance-chatbot).
  // The chat is NOT tied to the selected symbol; the user can ask about any coin.
  const handleChatAsk = async (e: FormEvent) => {
    e.preventDefault();

    const question = chatInput.trim();
    if (!question) return;

    // Add user message to the local chat history
    setChatMessages((prev) => [...prev, { sender: 'user', text: question }]);
    setChatInput('');
    setChatLoading(true);

    try {
      const resp = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, sessionId: chatSessionId }),
      });

      const data = await resp.json();

      const replyText: string =
        typeof data.reply === 'string'
          ? data.reply
          : data.error || 'Sorry, I could not get a response from the Finance Agent.';

      setChatMessages((prev) => [
        ...prev,
        {
          sender: 'ai',
          text: replyText,
        },
      ]);
    } catch (err: any) {
      console.error(err);
      setChatMessages((prev) => [
        ...prev,
        {
          sender: 'ai',
          text:
            'Something went wrong while contacting the Finance Agent. Please try again.',
        },
      ]);
    } finally {
      setChatLoading(false);
    }
  };

  // ---- AUTH HANDLERS ----
  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setAuthInfo(null);
    setAuthLoading(true);

    try {
      const session = await signInWithEmail(loginEmail.trim(), loginPassword);

      const idToken = session.getIdToken().getJwtToken();
      const accessToken = session.getAccessToken().getJwtToken();

      if (typeof window !== 'undefined') {
        localStorage.setItem('cognito_id_token', idToken);
        localStorage.setItem('cognito_access_token', accessToken);
        localStorage.setItem('cognito_user_email', loginEmail.trim());
      }

      setIsAuthenticated(true);
      setAuthEmail(loginEmail.trim());
    } catch (err: any) {
      console.error(err);
      const msg =
        err?.message ||
        err?.code ||
        'Failed to sign in. Please check your email and password.';
      setAuthError(msg);
    } finally {
      setAuthLoading(false);
    }
  };

  const handleSignup = async (e: FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setAuthInfo(null);
    setAuthLoading(true);

    try {
      const email = loginEmail.trim();
      await signUpWithEmail(email, loginPassword);
      setPendingConfirmEmail(email);
      setAuthMode('confirm');
      setAuthInfo(
        'Account created. We sent a confirmation code to your email. Enter it below to activate your account.'
      );
    } catch (err: any) {
      console.error(err);
      const msg =
        err?.message || err?.code || 'Failed to sign up. Please try again.';
      setAuthError(msg);
    } finally {
      setAuthLoading(false);
    }
  };

  const handleConfirm = async (e: FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setAuthInfo(null);
    setAuthLoading(true);

    try {
      const email = (pendingConfirmEmail || loginEmail).trim();
      if (!email) {
        throw new Error('Missing email for confirmation. Please sign up again.');
      }

      await confirmSignUp(email, confirmCode.trim());
      setAuthInfo('Account confirmed. You can now sign in.');
      setAuthMode('login');
      setConfirmCode('');
      setPendingConfirmEmail(null);
    } catch (err: any) {
      console.error(err);
      const msg =
        err?.message || err?.code || 'Failed to confirm account. Please try again.';
      setAuthError(msg);
    } finally {
      setAuthLoading(false);
    }
  };

  const handleLogout = () => {
    if (typeof window !== 'undefined') {
      localStorage.removeItem('cognito_id_token');
      localStorage.removeItem('cognito_access_token');
      localStorage.removeItem('cognito_user_email');
    }
    setIsAuthenticated(false);
    setAuthEmail(null);
    setTopCoins([]);
    setSelectedSymbol(null);
    setHistory([]);
  };

  // ----------------- UI blocks -----------------

  const renderTopCoins = () => {
    if (topError) {
      return (
        <p style={{ color: '#f97316', marginBottom: '1rem' }}>
          Failed to load top crypto: {topError}
        </p>
      );
    }
    if (!topCoins.length) return null;

    const topForCards = topCoins.slice(0, 5);

    return (
      <div
        style={{
          marginTop: '1.5rem',
          marginBottom: '1rem',
          padding: '1rem',
          borderRadius: 16,
          border: '1px solid #1f2937',
          background:
            'radial-gradient(circle at top left, #020617 0, #020617 40%, #020617 100%)',
          boxShadow: '0 18px 40px rgba(0,0,0,0.45)',
        }}
      >
        <div
          style={{
            marginBottom: '0.75rem',
            fontWeight: 600,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            fontSize: '0.95rem',
          }}
        >
          <span>Top Crypto (Binance US 24h)</span>
          <span style={{ color: '#6b7280', fontSize: '0.75rem' }}>
            Tap a card to view chart
          </span>
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
            gap: '0.75rem',
          }}
        >
          {topForCards.map((c) => {
            const change = c.priceChangePercent;
            const changeColor =
              change > 0 ? '#22c55e' : change < 0 ? '#ef4444' : '#e5e7eb';
            const isActive = selectedSymbol === c.symbol;
            const niceName =
              CRYPTO_NAME_MAP[c.symbol] || c.symbol.replace('USDT', '');

            return (
              <button
                key={c.symbol}
                onClick={() => {
                  setSymbol(c.symbol);
                  void loadHistory(c.symbol);
                }}
                style={{
                  padding: '0.75rem',
                  borderRadius: 14,
                  border: isActive
                    ? '1.5px solid #3b82f6'
                    : '1px solid #374151',
                  background:
                    'linear-gradient(145deg, rgba(15,23,42,0.9), rgba(15,23,42,0.6))',
                  fontSize: '0.9rem',
                  textAlign: 'left',
                  cursor: 'pointer',
                  transition: 'transform 0.12s ease, box-shadow 0.12s ease',
                }}
              >
                <div style={{ fontWeight: 600 }}>{niceName}</div>
                <div
                  style={{
                    color: '#9ca3af',
                    fontSize: '0.8rem',
                    marginBottom: '0.15rem',
                  }}
                >
                  {c.symbol}
                </div>
                <div style={{ marginTop: '0.1rem' }}>
                  <span style={{ color: '#9ca3af', fontSize: '0.75rem' }}>
                    Price
                  </span>{' '}
                  <span>${formatNumber(c.lastPrice, 4)}</span>
                </div>
                <div>
                  <span style={{ color: '#9ca3af', fontSize: '0.75rem' }}>
                    24h
                  </span>{' '}
                  <span style={{ color: changeColor }}>
                    {change > 0 ? '+' : ''}
                    {formatNumber(change, 2)}%
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  const renderHistoryChart = () => {
    if (!selectedSymbol) return null;

    if (historyLoading) {
      return <p style={{ marginBottom: '1rem' }}>Loading chart…</p>;
    }

    if (historyError) {
      return (
        <p style={{ marginBottom: '1rem', color: '#f97316' }}>
          Failed to load chart: {historyError}
        </p>
      );
    }

    if (!history.length) return null;

    const chartData = history.map((p) => ({
      ...p,
      label: new Date(p.time).toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
      }),
    }));

    const niceName =
      (selectedSymbol && CRYPTO_NAME_MAP[selectedSymbol]) ||
      (selectedSymbol ? selectedSymbol.replace('USDT', '') : '');

    return (
      <div
        style={{
          marginBottom: '1.5rem',
          padding: '1.2rem',
          borderRadius: 16,
          border: '1px solid #1f2937',
          background:
            'radial-gradient(circle at top, #020617 0, #020617 45%, #020617 100%)',
          boxShadow: '0 18px 40px rgba(0,0,0,0.45)',
          height: 280,
        }}
      >
        <div
          style={{
            marginBottom: '0.5rem',
            fontWeight: 600,
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: '0.95rem',
          }}
        >
          <span>
            {niceName} ({selectedSymbol}) — last 100 candles (1h)
          </span>
        </div>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData}>
            <defs>
              <linearGradient id="priceFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.6} />
                <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="label"
              tick={{ fontSize: 10, fill: '#9ca3af' }}
              minTickGap={20}
            />
            <YAxis
              tick={{ fontSize: 10, fill: '#9ca3af' }}
              domain={['dataMin', 'dataMax']}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: '#020617',
                border: '1px solid #4b5563',
                color: '#e5e7eb',
                fontSize: 12,
              }}
              formatter={(value: any) => [`$${Number(value).toFixed(4)}`, 'Close']}
            />
            <Area
              type="monotone"
              dataKey="close"
              stroke="#3b82f6"
              fill="url(#priceFill)"
              strokeWidth={2}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    );
  };

  // (renderPrediction removed)

  const renderChat = () => {
    return (
      <div
        style={{
          marginTop: '1.5rem',
          padding: '1.6rem',
          borderRadius: 16,
          border: '1px solid #1f2937',
          background:
            'radial-gradient(circle at top, #020617 0, #020617 45%, #020617 100%)',
          boxShadow: '0 18px 40px rgba(0,0,0,0.45)',
        }}
      >
        <h2
          style={{
            fontSize: '1.05rem',
            fontWeight: 600,
            marginBottom: '0.4rem',
          }}
        >
          Chat with Finance AI
        </h2>
        <p
          style={{
            fontSize: '1rem',
            color: '#9ca3af',
            marginBottom: '0.75rem',
          }}
        >
          Ask anything about crypto markets, indicators, or forecasts. For example:
          &quot;What is the RSI of Bitcoin?&quot;, &quot;Give me a forecast for ETH&quot;, or
          &quot;Compare BTC and SOL in simple terms.&quot;
        </p>

        <div
          style={{
            maxHeight: 380,
            overflowY: 'auto',
            padding: '0.85rem',
            borderRadius: 12,
            border: '1px solid #111827',
            backgroundColor: '#020617',
            marginBottom: '0.75rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.4rem',
            fontSize: '1rem',
          }}
        >
          {chatMessages.length === 0 && (
            <div style={{ color: '#6b7280', fontSize: '0.95rem' }}>
              Example questions: &quot;Is BTC overbought right now?&quot;, &quot;How risky is
              ETH this week?&quot;, or &quot;Explain RSI like I&apos;m new to trading.&quot;
            </div>
          )}

          {chatMessages.map((m, idx) => (
            <div
              key={idx}
              style={{
                alignSelf: m.sender === 'user' ? 'flex-end' : 'flex-start',
                maxWidth: '80%',
                padding: '0.75rem 1rem',
                borderRadius: 12,
                background:
                  m.sender === 'user'
                    ? 'linear-gradient(135deg, #3b82f6, #1d4ed8)'
                    : '#020617',
                color: m.sender === 'user' ? '#f9fafb' : '#e5e7eb',
                border:
                  m.sender === 'ai' ? '1px solid #1f2937' : '1px solid transparent',
                fontSize: '1rem',
                whiteSpace: 'pre-wrap',
              }}
            >
              {m.text}
            </div>
          ))}

          {chatLoading && (
            <div
              style={{
                alignSelf: 'flex-start',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.4rem',
                padding: '0.3rem 0.6rem',
                borderRadius: 9999,
                border: '1px solid #1f2937',
                backgroundColor: '#020617',
                fontSize: '0.9rem',
                color: '#9ca3af',
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 9999,
                  background:
                    'radial-gradient(circle at 30% 30%, #bfdbfe, #3b82f6)',
                  animation: 'pulse-dot 1s ease-in-out infinite',
                }}
              />
              Thinking…
            </div>
          )}
        </div>

        <form
          onSubmit={handleChatAsk}
          style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}
        >
          <input
            type="text"
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            placeholder="Ask anything about crypto…"
            style={{
              flex: 1,
              padding: '0.85rem 1.1rem',
              borderRadius: 9999,
              border: '1px solid #4b5563',
              backgroundColor: '#020617',
              color: '#e5e7eb',
              fontSize: '1rem',
            }}
            disabled={chatLoading}
          />
          <button
            type="submit"
            disabled={chatLoading || !chatInput.trim()}
            style={{
              padding: '0.85rem 1.4rem',
              borderRadius: 9999,
              border: 'none',
              background:
                'linear-gradient(135deg, rgba(94,234,212,0.18), rgba(56,189,248,0.4))',
              color: '#e5e7eb',
              cursor: chatLoading || !chatInput.trim() ? 'default' : 'pointer',
              fontWeight: 600,
              fontSize: '1rem',
              opacity: chatLoading || !chatInput.trim() ? 0.7 : 1,
            }}
          >
            {chatLoading ? 'Asking…' : 'Ask AI'}
          </button>
        </form>
      </div>
    );
  };

  // ----------------- MAIN RENDER -----------------

  // If NOT authenticated -> show login page instead of analyzer
  if (!isAuthenticated) {
    return (
      <main
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#020617',
          color: '#e5e7eb',
          fontFamily:
            'system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
        }}
      >
        <div
          style={{
            width: '100%',
            maxWidth: 400,
            padding: '2rem',
            borderRadius: 16,
            border: '1px solid #1f2937',
            background:
              'radial-gradient(circle at top, #020617 0, #020617 45%, #020617 100%)',
            boxShadow: '0 18px 40px rgba(0,0,0,0.45)',
          }}
        >
          <h1
            style={{
              fontSize: '1.5rem',
              fontWeight: 700,
              marginBottom: '0.5rem',
              textAlign: 'center',
            }}
          >
            {authMode === 'login'
              ? 'Sign in to Crypto AI STOCK ANALYST'
              : authMode === 'signup'
              ? 'Create your account'
              : 'Confirm your account'}
          </h1>
          <p
            style={{
              fontSize: '0.9rem',
              color: '#9ca3af',
              marginBottom: '1.5rem',
              textAlign: 'center',
            }}
          >
            {authMode === 'login'
              ? 'Use your email and password from the Cognito user pool.'
              : authMode === 'signup'
              ? 'Enter your email and a password to create an account.'
              : pendingConfirmEmail
              ? `We sent a confirmation code to ${pendingConfirmEmail}. Enter it below to activate your account.`
              : 'Enter the confirmation code sent to your email.'}
          </p>

          <form
            onSubmit={
              authMode === 'login'
                ? handleLogin
                : authMode === 'signup'
                ? handleSignup
                : handleConfirm
            }
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '0.9rem',
            }}
          >
            <div>
              <label
                htmlFor="email"
                style={{
                  display: 'block',
                  fontSize: '0.85rem',
                  marginBottom: '0.25rem',
                }}
              >
                Email
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                value={loginEmail}
                onChange={(e) => setLoginEmail(e.target.value)}
                required
                style={{
                  width: '100%',
                  padding: '0.7rem 0.8rem',
                  borderRadius: 9999,
                  border: '1px solid #4b5563',
                  backgroundColor: '#020617',
                  color: '#e5e7eb',
                  fontSize: '0.9rem',
                }}
              />
            </div>

            {authMode !== 'confirm' && (
              <div>
                <label
                  htmlFor="password"
                  style={{
                    display: 'block',
                    fontSize: '0.85rem',
                    marginBottom: '0.25rem',
                  }}
                >
                  Password
                </label>
                <input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  required
                  style={{
                    width: '100%',
                    padding: '0.7rem 0.8rem',
                    borderRadius: 9999,
                    border: '1px solid #4b5563',
                    backgroundColor: '#020617',
                    color: '#e5e7eb',
                    fontSize: '0.9rem',
                  }}
                />
              </div>
            )}

            {authMode === 'confirm' && (
              <div>
                <label
                  htmlFor="confirmCode"
                  style={{
                    display: 'block',
                    fontSize: '0.85rem',
                    marginBottom: '0.25rem',
                  }}
                >
                  Confirmation code
                </label>
                <input
                  id="confirmCode"
                  type="text"
                  value={confirmCode}
                  onChange={(e) => setConfirmCode(e.target.value)}
                  placeholder="Enter the code from your email"
                  required
                  style={{
                    width: '100%',
                    padding: '0.7rem 0.8rem',
                    borderRadius: 9999,
                    border: '1px solid #4b5563',
                    backgroundColor: '#020617',
                    color: '#e5e7eb',
                    fontSize: '0.9rem',
                  }}
                />
              </div>
            )}

            {authError && (
              <p style={{ color: '#f97316', fontSize: '0.85rem' }}>
                {authError}
              </p>
            )}

            {authInfo && (
              <p style={{ color: '#22c55e', fontSize: '0.85rem' }}>
                {authInfo}
              </p>
            )}

            <button
              type="submit"
              disabled={authLoading}
              style={{
                marginTop: '0.5rem',
                padding: '0.75rem 1.4rem',
                borderRadius: 9999,
                border: 'none',
                background:
                  'linear-gradient(135deg, #3b82f6, #1d4ed8)',
                color: '#fff',
                cursor: 'pointer',
                fontWeight: 600,
                fontSize: '0.9rem',
                opacity: authLoading ? 0.75 : 1,
              }}
            >
              {authLoading
                ? authMode === 'login'
                  ? 'Signing in…'
                  : authMode === 'signup'
                  ? 'Creating account…'
                  : 'Confirming…'
                : authMode === 'login'
                ? 'Sign in'
                : authMode === 'signup'
                ? 'Sign up'
                : 'Confirm account'}
            </button>

            <p
              style={{
                marginTop: '0.75rem',
                fontSize: '0.8rem',
                color: '#9ca3af',
                textAlign: 'center',
              }}
            >
              {authMode === 'login' ? (
                <>
                  Don&apos;t have an account?{' '}
                  <button
                    type="button"
                    onClick={() => {
                      setAuthMode('signup');
                      setAuthError(null);
                      setAuthInfo(null);
                      setConfirmCode('');
                      setPendingConfirmEmail(null);
                    }}
                    style={{
                      border: 'none',
                      background: 'transparent',
                      color: '#3b82f6',
                      cursor: 'pointer',
                      padding: 0,
                      fontSize: '0.8rem',
                    }}
                  >
                    Sign up
                  </button>
                </>
              ) : (
                <>
                  Already have an account?{' '}
                  <button
                    type="button"
                    onClick={() => {
                      setAuthMode('login');
                      setAuthError(null);
                      setAuthInfo(null);
                      setConfirmCode('');
                      setPendingConfirmEmail(null);
                    }}
                    style={{
                      border: 'none',
                      background: 'transparent',
                      color: '#3b82f6',
                      cursor: 'pointer',
                      padding: 0,
                      fontSize: '0.8rem',
                    }}
                  >
                    Sign in
                  </button>
                </>
              )}
            </p>
          </form>
        </div>
      </main>
    );
  }

  // If authenticated -> show analyzer UI
  return (
    <main
      style={{
        minHeight: '100vh',
        padding: '2rem',
        fontFamily:
          'system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
        backgroundColor: '#020617',
        color: '#e5e7eb',
      }}
    >
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '0.75rem',
        }}
      >
        <div>
          <h1
            style={{
              fontSize: '1.6rem',
              fontWeight: 700,
              marginBottom: '0.3rem',
            }}
          >
            Crypto AI STOCK ANALYST
          </h1>
        </div>

        <div style={{ textAlign: 'right' }}>
          {authEmail && (
            <div
              style={{
                fontSize: '0.8rem',
                color: '#9ca3af',
                marginBottom: '0.25rem',
              }}
            >
              Signed in as <span style={{ color: '#e5e7eb' }}>{authEmail}</span>
            </div>
          )}
          <button
            type="button"
            onClick={handleLogout}
            style={{
              padding: '0.4rem 0.9rem',
              borderRadius: 9999,
              border: '1px solid #4b5563',
              backgroundColor: '#020617',
              color: '#e5e7eb',
              fontSize: '0.8rem',
              cursor: 'pointer',
            }}
          >
            Logout
          </button>
        </div>
      </header>

      {renderTopCoins()}
      {renderHistoryChart()}

      {/* Symbol dropdown – controls only the chart; no Analyze button now */}
      <section
        style={{
          marginTop: '0.75rem',
          display: 'flex',
          gap: '0.5rem',
          maxWidth: 520,
        }}
      >
        <select
          value={symbol}
          onChange={(e) => {
            const newSymbol = e.target.value;
            setSymbol(newSymbol);
            void loadHistory(newSymbol);
          }}
          style={{
            padding: '0.75rem 0.9rem',
            borderRadius: 9999,
            border: '1px solid #4b5563',
            flex: 1,
            backgroundColor: '#020617',
            color: '#e5e7eb',
            fontSize: '0.9rem',
          }}
        >
          {topCoins.map((c) => {
            const niceName =
              CRYPTO_NAME_MAP[c.symbol] || c.symbol.replace('USDT', '');
            return (
              <option key={c.symbol} value={c.symbol}>
                {niceName} ({c.symbol})
              </option>
            );
          })}
        </select>
      </section>

      {renderChat()}

      <style jsx>{`
        .spinner-dot {
          width: 14px;
          height: 14px;
          border-radius: 9999px;
          border: 2px solid #4b5563;
          border-top-color: #3b82f6;
          animation: spin 0.6s linear infinite;
        }

        @keyframes spin {
          to {
            transform: rotate(360deg);
          }
        }

        @keyframes pulse-dot {
          0% {
            transform: scale(1);
            opacity: 0.6;
          }
          50% {
            transform: scale(1.25);
            opacity: 1;
          }
          100% {
            transform: scale(1);
            opacity: 0.6;
          }
        }
      `}</style>
    </main>
  );
}
