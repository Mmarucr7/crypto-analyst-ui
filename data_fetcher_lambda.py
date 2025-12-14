import os
import json
import logging
import datetime as dt
from typing import List, Dict, Optional, Any

import boto3
import requests

logger = logging.getLogger()
logger.setLevel(logging.INFO)

s3 = boto3.client("s3")
DATA_BUCKET = os.environ.get("DATA_BUCKET", "finanalyst-storage")

def fetch_binance_klines(symbol: str, interval: str = "1h", limit: int = 200) -> List[Dict]:
    url = "https://api.binance.us/api/v3/klines"
    params = {"symbol": symbol, "interval": interval, "limit": limit}
    r = requests.get(url, params=params, timeout=10)
    r.raise_for_status()
    raw = r.json()

    candles: List[Dict] = []
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


def fetch_binance_ticker_24h(symbol: str) -> Optional[Dict]:
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
        logger.error(f"Error fetching 24h ticker for {symbol}: {e}")
        return None


def save_to_s3(symbol: str, source: str, data: List[Dict]) -> str:
    """Save raw OHLCV candles."""
    now = dt.datetime.utcnow()
    key = (
        f"raw/{source}/{symbol}/"
        f"{now.strftime('%Y-%m-%d')}/"
        f"{symbol}_{source}_{now.strftime('%Y%m%dT%H%M%SZ')}.json"
    )
    s3.put_object(
        Bucket=DATA_BUCKET,
        Key=key,
        Body=json.dumps(data).encode("utf-8"),
        ContentType="application/json",
    )
    return key


def save_result_to_s3(symbol: str, interval: str, result_body: Dict) -> str:
    """
    Save the aggregated result (the same JSON the AI reads) under
    data_fetcher_results/<SYMBOL>/<YYYY-MM-DD>/<symbol>_<interval>_<timestamp>_data_fetcher.json
    """
    now = dt.datetime.utcnow()
    key = (
        f"data_fetcher_results/{symbol}/"
        f"{now.strftime('%Y-%m-%d')}/"
        f"{symbol}_{interval}_{now.strftime('%Y%m%dT%H%M%SZ')}_data_fetcher.json"
    )
    s3.put_object(
        Bucket=DATA_BUCKET,
        Key=key,
        Body=json.dumps(result_body).encode("utf-8"),
        ContentType="application/json",
    )
    return key

def _parse_properties_to_dict(body: Any) -> Dict[str, Any]:
    """
    Bedrock Agent sends tool input as:
      requestBody.content.application/json.properties: [{name, type, value}, ...]
    Convert that into a simple dict: {name: parsed_value, ...}
    """
    if not isinstance(body, dict):
        return {}

    props = body.get("properties")
    if isinstance(props, list):
        out: Dict[str, Any] = {}
        for p in props:
            name = p.get("name")
            value = p.get("value")
            p_type = p.get("type")

            if not name:
                continue

            if p_type == "integer":
                try:
                    out[name] = int(value)
                except Exception:
                    out[name] = value
            elif p_type == "number":
                try:
                    out[name] = float(value)
                except Exception:
                    out[name] = value
            elif p_type == "boolean":
                
                if isinstance(value, bool):
                    out[name] = value
                elif isinstance(value, str):
                    out[name] = value.lower() == "true"
                else:
                    out[name] = bool(value)
            else:
                out[name] = value
        return out

    return body


def _get_json_body(event: Dict) -> Dict[str, Any]:
    """
    Extract a normalized JSON body from the Bedrock Agent event.
    """
    body = (
        event.get("requestBody", {})
        .get("content", {})
        .get("application/json", {})
    )
    return _parse_properties_to_dict(body)


def _extract_symbol(event: Dict) -> Optional[str]:
    """Get 'symbol' from normalized body or parameters."""
    body = _get_json_body(event)
    symbol = body.get("symbol")
    if symbol:
        return str(symbol).upper()

    params = event.get("parameters") or []
    if isinstance(params, list):
        for p in params:
            if p.get("name") == "symbol" and p.get("value"):
                return str(p["value"]).upper()

    return None


def lambda_handler(event, context):
    """
    Handler for Bedrock Agent action group (Lambda tool).
    """
    logger.info("Incoming event: %s", json.dumps(event))

    symbol = _extract_symbol(event)

    if not symbol:

        error_body = {
            "error": "Missing required parameter 'symbol'. Please specify a crypto symbol such as BTCUSDT, ETHUSDT, or SOLUSDT."
        }
        response = {
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
                }
            }
        }
        logger.warning("Missing symbol in event, returning 400 error.")
        return response

    
    body = _get_json_body(event)
    interval = body.get("interval", "1h")
    limit = int(body.get("limit", 100))
    save_flag = bool(body.get("save_to_s3", True))

    source = "binance"

    
    candles = fetch_binance_klines(symbol, interval, limit)

    
    market_snapshot = fetch_binance_ticker_24h(symbol)

    
    s3_key = None
    if save_flag:
        s3_key = save_to_s3(symbol, source, candles)

    
    result_body = {
        "symbol": symbol,
        "source": source,
        "interval": interval,
        "count": len(candles),
        "s3_bucket": DATA_BUCKET,
        "s3_key": s3_key,
        "sample": candles[-1] if candles else None,
        "market_snapshot": market_snapshot,
    }

    
    result_s3_key = save_result_to_s3(symbol, interval, result_body)
    result_body["result_s3_bucket"] = DATA_BUCKET
    result_body["result_s3_key"] = result_s3_key

    
    response = {
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
            }
        }
    }

    logger.info("Response to agent: %s", json.dumps(response))
    return response