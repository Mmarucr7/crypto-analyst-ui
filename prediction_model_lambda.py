import os
import json
import logging
import datetime as dt
from typing import Dict, Any, List, Optional

import boto3
import requests
import pandas as pd
from botocore.exceptions import ClientError
import time

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# ---------- CONFIG ----------

PREDICTIONS_BUCKET = os.environ.get("PREDICTIONS_BUCKET", "finanalyst-analysis")
DEFAULT_INTERVAL = "1h"
DEFAULT_LIMIT = 100

s3 = boto3.client("s3")
bedrock = boto3.client("bedrock-runtime")


# ---------- SIMPLE INDICATOR HELPERS ----------

def compute_rsi(series: pd.Series, period: int = 14) -> pd.Series:
    delta = series.diff()
    gain = (delta.where(delta > 0, 0.0)).rolling(window=period).mean()
    loss = (-delta.where(delta < 0, 0.0)).rolling(window=period).mean()
    rs = gain / loss.replace(0, 1e-9)
    rsi = 100 - (100 / (1 + rs))
    return rsi


def interpret_rsi(value: float) -> str:
    if value >= 70:
        return "Overbought (risk of pullback)"
    elif value <= 30:
        return "Oversold (potential bounce)"
    elif 45 <= value <= 55:
        return "Neutral"
    elif value > 50:
        return "Moderately bullish"
    else:
        return "Moderately bearish"


def interpret_trend(short: float, long: float) -> str:
    if short > long:
        return "Bullish (short MA above long MA)"
    elif short < long:
        return "Bearish (short MA below long MA)"
    else:
        return "No clear trend (MAs equal)"



def fetch_binance_klines(
    symbol: str,
    interval: str = DEFAULT_INTERVAL,
    limit: int = DEFAULT_LIMIT,
) -> List[Dict[str, Any]]:
    url = "https://api.binance.us/api/v3/klines"
    params = {"symbol": symbol, "interval": interval, "limit": limit}
    r = requests.get(url, params=params, timeout=10)
    r.raise_for_status()
    raw = r.json()

    candles: List[Dict[str, Any]] = []
    for c in raw:
        candles.append(
            {
                "open_time": int(c[0]),
                "open": float(c[1]),
                "high": float(c[2]),
                "low": float(c[3]),
                "close": float(c[4]),
                "volume": float(c[5]),
                "close_time": int(c[6]),
            }
        )
    return candles


def fetch_market_snapshot(symbol: str) -> Optional[Dict[str, Any]]:
    url = "https://api.binance.us/api/v3/ticker/24hr"
    params = {"symbol": symbol}
    try:
        r = requests.get(url, params=params, timeout=10)
        r.raise_for_status()
        data = r.json()
        return {
            "exchange": "binance.us",
            "symbol": symbol,
            "current_price_usd": float(data.get("lastPrice", 0.0)),
            "price_change_percentage_24h": float(data.get("priceChangePercent", 0.0)),
            "market_cap_usd": None,
        }
    except Exception as e:
        logger.error(f"Error fetching market snapshot for {symbol}: {e}")
        return None



def invoke_bedrock_with_retry(payload: dict, max_retries: int = 2):
    """
    Small retry loop for Bedrock throttling / rate-limit errors.
    """
    body_str = json.dumps(payload)
    last_err: Optional[Exception] = None

    logger.info("Invoking Bedrock with payload (truncated): %s",
                body_str[:1000])

    for attempt in range(max_retries + 1):
        try:
            resp = bedrock.invoke_model(
                modelId="anthropic.claude-3-sonnet-20240229-v1:0",
                body=body_str,
            )
            logger.info("Bedrock invoke_model succeeded on attempt %d", attempt + 1)
            return resp
        except ClientError as e:
            err_code = e.response.get("Error", {}).get("Code", "")
            err_msg = e.response.get("Error", {}).get("Message", "")

            is_throttle = (
                err_code in ("ThrottlingException", "TooManyRequestsException")
                or "Your request rate is too high" in err_msg
            )

            if is_throttle and attempt < max_retries:
                delay = 0.5 * (2 ** attempt)  # 0.5s, 1s, 2s...
                logger.warning(
                    f"Bedrock throttled (attempt {attempt+1}/{max_retries+1}), "
                    f"sleeping {delay:.2f}s before retry... "
                    f"(code={err_code}, message={err_msg})"
                )
                time.sleep(delay)
                last_err = e
                continue

            logger.error("Bedrock invoke_model failed (non-throttle or max retries): %s", e)
            raise

        except Exception as e:
            logger.error("Unexpected error invoking Bedrock: %s", e)
            raise

    if last_err:
        raise last_err



PREDICTION_PROMPT_TEMPLATE = """
You are a concise quantitative crypto analyst.

You receive a JSON object with:
- symbol
- interval
- indicators: latest RSI, SMA, EMA values + text signals
- market_snapshot: current_price_usd, price_change_percentage_24h, market_cap_usd (may be null)

Using ONLY that JSON, do:

1) Decide a trading stance: BUY, HOLD, or SELL for the symbol.
2) Produce short forecasts for:
   - 1_week, 1_month, 3_months, 6_months, 12_months, 5_years
   Each with:
     - direction: "UP" | "DOWN" | "SIDEWAYS"
     - expected_change_percent: range string, e.g. "-8% to +15%"
     - confidence: integer 0–100
3) Provide 3–6 short risk bullet points.

Be brief and structured.

OUTPUT:
Return ONLY valid JSON with EXACTLY this structure:

{
  "symbol": "<symbol>",
  "recommendation": "BUY | HOLD | SELL",
  "reasoning": "<short explanation>",
  "forecasts": {
    "1_week": {
      "direction": "UP | DOWN | SIDEWAYS",
      "expected_change_percent": "<range>",
      "confidence": <number>
    },
    "1_month": {
      "direction": "UP | DOWN | SIDEWAYS",
      "expected_change_percent": "<range>",
      "confidence": <number>
    },
    "3_months": {
      "direction": "UP | DOWN | SIDEWAYS",
      "expected_change_percent": "<range>",
      "confidence": <number>
    },
    "6_months": {
      "direction": "UP | DOWN | SIDEWAYS",
      "expected_change_percent": "<range>",
      "confidence": <number>
    },
    "12_months": {
      "direction": "UP | DOWN | SIDEWAYS",
      "expected_change_percent": "<range>",
      "confidence": <number>
    },
    "5_years": {
      "direction": "UP | DOWN | SIDEWAYS",
      "expected_change_percent": "<range>",
      "confidence": <number>
    }
  },
  "risks": [
    "<risk_1>",
    "<risk_2>",
    "<risk_3>"
  ]
}

Do not add any extra fields. Do not output markdown.

Here is the JSON:

{{INDICATOR_JSON}}
"""



def _properties_to_dict(props: List[Dict[str, Any]]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for p in props:
        name = p.get("name")
        value = p.get("value")
        if name is not None:
            out[name] = value
    return out


def _extract_request_payload(event: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle Bedrock Agent tool format:

    requestBody: {
      "content": {
        "application/json": {
          "properties": [
            {"name": "symbol", "type": "string", "value": "ETHUSDT"},
            ...
          ]
        }
      }
    }

    Also supports older requestBody.application/json.properties[] if ever used.
    """
    rb = event.get("requestBody", {}) or {}

    
    content = rb.get("content")
    if isinstance(content, dict):
        app_json = content.get("application/json")
        if isinstance(app_json, dict):
            props = app_json.get("properties")
            if isinstance(props, list):
                return _properties_to_dict(props)

    
    app_json2 = rb.get("application/json")
    if isinstance(app_json2, dict):
        props = app_json2.get("properties")
        if isinstance(props, list):
            return _properties_to_dict(props)

    
    return {}


def _is_bedrock_agent_event(event: Dict[str, Any]) -> bool:
    return isinstance(event, dict) and "messageVersion" in event and "actionGroup" in event



def lambda_handler(event, context):
    logger.info(f"Event received: {json.dumps(event)}")

    
    if not _is_bedrock_agent_event(event):
        logger.warning("Non-Bedrock-Agent event received; ignoring (no processing).")
        
        return {
            "statusCode": 200,
            "body": json.dumps(
                {"message": "predictions_lambda is only used as a Bedrock Agent tool."}
            ),
        }

    
    payload = _extract_request_payload(event)
    logger.info(f"Parsed payload: {json.dumps(payload)}")

    symbol = payload.get("symbol")
    if not symbol:
        error_body = {
            "error": "Missing required parameter 'symbol'. Please specify a trading pair such as BTCUSDT, ETHUSDT, or SOLUSDT."
        }
        return {
            "messageVersion": "1.0",
            "response": {
                "actionGroup": event.get("actionGroup"),
                "apiPath": event.get("apiPath"),
                "httpMethod": event.get("httpMethod", "POST"),
                "httpStatusCode": 400,
                "responseBody": {
                    "application/json": {
                        "body": error_body
                    }
                },
            },
        }

    symbol = str(symbol).upper()
    interval = payload.get("interval", DEFAULT_INTERVAL)

    limit_raw = payload.get("limit", DEFAULT_LIMIT)
    try:
        limit = int(limit_raw)
    except Exception:
        limit = DEFAULT_LIMIT

    save_to_s3 = bool(payload.get("save_to_s3", True))

    # 1) Fetch candles
    candles = fetch_binance_klines(symbol, interval, limit)
    logger.info("Fetched %d candles for %s (%s)", len(candles), symbol, interval)

    if not candles:
        error_body = {"error": f"No candle data returned for {symbol}."}
        return {
            "messageVersion": "1.0",
            "response": {
                "actionGroup": event.get("actionGroup"),
                "apiPath": event.get("apiPath"),
                "httpMethod": event.get("httpMethod", "POST"),
                "httpStatusCode": 500,
                "responseBody": {
                    "application/json": {
                        "body": error_body
                    }
                },
            },
        }

    # 2) Build df + indicators (only last values)
    df = pd.DataFrame(candles)
    logger.info("DataFrame columns: %s", list(df.columns))

    if "close" not in df.columns:
        error_body = {"error": "Candle data missing 'close' field."}
        logger.error("Candle data missing 'close' field for symbol %s", symbol)
        return {
            "messageVersion": "1.0",
            "response": {
                "actionGroup": event.get("actionGroup"),
                "apiPath": event.get("apiPath"),
                "httpMethod": event.get("httpMethod", "POST"),
                "httpStatusCode": 500,
                "responseBody": {
                    "application/json": {
                        "body": error_body
                    }
                },
            },
        }

    results: Dict[str, Any] = {
        "symbol": symbol,
        "interval": interval,
        "indicators": {},
    }

    # RSI
    df["rsi"] = compute_rsi(df["close"], 14)
    last_rsi = float(df["rsi"].iloc[-1])
    results["indicators"]["RSI"] = {
        "value": last_rsi,
        "signal": interpret_rsi(last_rsi),
    }

    
    sma_short = 20
    sma_long = 50
    df["sma_short"] = df["close"].rolling(window=sma_short).mean()
    df["sma_long"] = df["close"].rolling(window=sma_long).mean()
    df["ema_short"] = df["close"].ewm(span=sma_short, adjust=False).mean()
    df["ema_long"] = df["close"].ewm(span=sma_long, adjust=False).mean()

    sma_s = float(df["sma_short"].iloc[-1])
    sma_l = float(df["sma_long"].iloc[-1])
    ema_s = float(df["ema_short"].iloc[-1])
    ema_l = float(df["ema_long"].iloc[-1])

    results["indicators"]["SMA"] = {
        "short_period": sma_short,
        "long_period": sma_long,
        "short_value": sma_s,
        "long_value": sma_l,
        "signal": interpret_trend(sma_s, sma_l),
    }

    results["indicators"]["EMA"] = {
        "short_period": sma_short,
        "long_period": sma_long,
        "short_value": ema_s,
        "long_value": ema_l,
        "signal": interpret_trend(ema_s, ema_l),
    }

    logger.info(
        "Indicators for %s: RSI=%.2f, SMA_short=%.2f, SMA_long=%.2f, EMA_short=%.2f, EMA_long=%.2f",
        symbol, last_rsi, sma_s, sma_l, ema_s, ema_l
    )

    # 3) Market snapshot
    market_snapshot = fetch_market_snapshot(symbol)
    logger.info("Market snapshot for %s: %s", symbol, market_snapshot)

    if market_snapshot:
        results["market_snapshot"] = market_snapshot

    # 4) Build compact prompt for Bedrock
    indicator_json_str = json.dumps(results, separators=(",", ":"))
    logger.info("Indicator JSON (truncated): %s", indicator_json_str[:1000])

    prompt = PREDICTION_PROMPT_TEMPLATE.replace("{{INDICATOR_JSON}}", indicator_json_str)

    logger.info("Calling Bedrock model (Sonnet) with reduced max_tokens")
    bedrock_payload = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 600,  # lower token budget
        "messages": [{"role": "user", "content": prompt}],
    }

    response = invoke_bedrock_with_retry(bedrock_payload)
    response_raw_body = response["body"].read()

    logger.info("Raw Bedrock response body (truncated): %s",
                response_raw_body[:1000])

    response_body = json.loads(response_raw_body)
    logger.info("Parsed Bedrock response JSON keys: %s", list(response_body.keys()))

    ai_output_text = response_body["content"][0]["text"]
    logger.info("AI output text (truncated): %s", ai_output_text[:1000])

    try:
        prediction = json.loads(ai_output_text)
        logger.info("Parsed prediction JSON summary: symbol=%s, recommendation=%s",
                    prediction.get("symbol"), prediction.get("recommendation"))
    except Exception as e:
        logger.error(f"Failed to parse model output as JSON: {e}")
        prediction = {
            "symbol": symbol,
            "recommendation": "HOLD",
            "reasoning": "Model output could not be parsed as JSON.",
            "forecasts": {},
            "risks": [],
        }

    
    if market_snapshot:
        prediction["market_snapshot"] = market_snapshot

    result_body: Dict[str, Any] = {
        "symbol": symbol,
        "interval": interval,
        "prediction": prediction,
    }

    logger.info("Final prediction object (truncated): %s",
                json.dumps(result_body)[:1000])

    # 5) Optional: save prediction JSON to S3
    if save_to_s3:
        now = dt.datetime.utcnow()
        date_folder = now.strftime("%Y-%m-%d")
        ts = now.strftime("%Y%m%dT%H%M%SZ")
        filename = f"{symbol}_binance_{ts}_prediction.json"
        output_key = f"Predictions/{symbol}/{date_folder}/{filename}"

        s3.put_object(
            Bucket=PREDICTIONS_BUCKET,
            Key=output_key,
            Body=json.dumps(prediction).encode("utf-8"),
            ContentType="application/json",
        )
        logger.info(f"Prediction saved to s3://{PREDICTIONS_BUCKET}/{output_key}")

        result_body["s3_bucket"] = PREDICTIONS_BUCKET
        result_body["s3_key"] = output_key

    # 6) Return as Agent tool response
    return {
        "messageVersion": "1.0",
        "response": {
            "actionGroup": event.get("actionGroup"),
            "apiPath": event.get("apiPath"),
            "httpMethod": event.get("httpMethod", "POST"),
            "httpStatusCode": 200,
            "responseBody": {
                "application/json": {
                    "body": result_body
                }
            },
        },
    }