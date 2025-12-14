import os
import json
import logging
import datetime as dt
from typing import Dict, List, Any

import boto3
import pandas as pd

logger = logging.getLogger()
logger.setLevel(logging.INFO)

s3 = boto3.client("s3")

INPUT_BUCKET = os.environ.get("DATA_BUCKET", "finanalyst-storage")
OUTPUT_BUCKET = os.environ.get("OUTPUT_BUCKET", INPUT_BUCKET)



def compute_rsi(series: pd.Series, period: int = 14) -> pd.Series:
    delta = series.diff()
    gain = (delta.where(delta > 0, 0.0)).rolling(window=period).mean()
    loss = (-delta.where(delta < 0, 0.0)).rolling(window=period).mean()
    rs = gain / loss.replace(0, 1e-9)
    rsi = 100 - (100 / (1 + rs))
    return rsi


def interpret_rsi(value: float) -> str:
    if value >= 70:
        return "Overbought (potential downside risk)"
    elif value <= 30:
        return "Oversold (potential upside opportunity)"
    elif 45 <= value <= 55:
        return "Neutral momentum"
    elif value > 50:
        return "Bullish momentum strengthening"
    else:
        return "Bearish momentum strengthening"


def interpret_trend(short: float, long: float) -> str:
    if short > long:
        return "Short-term trend is bullish (short SMA above long SMA)."
    elif short < long:
        return "Short-term trend is bearish (short SMA below long SMA)."
    else:
        return "Short- and long-term averages are equal (no clear trend)."



def _parse_properties(event: Dict[str, Any]) -> Dict[str, Any]:
    """
    Bedrock Agent sends tool args under:
      event["requestBody"]["content"]["application/json"]["properties"]
      as a list of { name, type, value }.
    Convert that into a simple dict.
    """
    props = (
        event
        .get("requestBody", {})
        .get("content", {})
        .get("application/json", {})
        .get("properties", [])
    )

    out: Dict[str, Any] = {}
    for p in props:
        name = p.get("name")
        value = p.get("value")
        if name:
            out[name] = value
    return out


def _load_candles_from_s3(bucket: str, key: str) -> pd.DataFrame:
    """
    Load candles from S3 and normalize:
    - If the JSON is a list → treat as raw candles (array of OHLCV objects).
    - If the JSON is a dict (aggregated result) → follow its s3_bucket/s3_key
      to the underlying raw candle file.
    """
    logger.info(f"Loading candles from s3://{bucket}/{key}")
    obj = s3.get_object(Bucket=bucket, Key=key)
    raw = obj["Body"].read()
    data = json.loads(raw)

    # Case 1: raw candles (list of dicts)
    if isinstance(data, list):
        candles = data

    # Case 2: aggregated result body (dict)
    elif isinstance(data, dict):
        
        if isinstance(data.get("candles"), list):
            candles = data["candles"]
       
        elif "s3_bucket" in data and "s3_key" in data:
            inner_bucket = data.get("s3_bucket", bucket)
            inner_key = data["s3_key"]
            logger.info(f"Found nested candle location: s3://{inner_bucket}/{inner_key}")
            inner_obj = s3.get_object(Bucket=inner_bucket, Key=inner_key)
            inner_raw = inner_obj["Body"].read()
            candles = json.loads(inner_raw)
        else:
            raise ValueError(
                "Unsupported JSON structure for candles: expected list of OHLCV "
                "objects or dict with 'candles' or 's3_bucket'/'s3_key'."
            )
    else:
        raise ValueError("Unexpected JSON root type for candle file.")

    if not candles:
        raise ValueError("Candle file is empty!")

    df = pd.DataFrame(candles)

    if "close" not in df.columns:
        raise ValueError("Candle data missing 'close' field.")

    return df


# ---------------- LAMBDA HANDLER (BEDROCK TOOL) ---------------- #

def lambda_handler(event, context):
    """
    Handler for Bedrock Agent action group (Lambda tool).

    Expected event shape (simplified):

    {
      "messageVersion": "1.0",
      "actionGroup": "tech_analyzer_action_group",
      "apiPath": "/technical_analysis",
      "httpMethod": "POST",
      "requestBody": {
        "content": {
          "application/json": {
            "properties": [
              {"name": "symbol", "type": "string", "value": "BTCUSDT"},
              {"name": "s3_bucket", "type": "string", "value": "finanalyst-storage"},
              {"name": "s3_key", "type": "string", "value": "raw/binance/BTCUSDT/...json"}
            ]
          }
        }
      }
    }
    """
    logger.info("Event received: %s", json.dumps(event))

    params = _parse_properties(event)
    symbol = params.get("symbol")
    s3_bucket = params.get("s3_bucket") or INPUT_BUCKET
    s3_key = params.get("s3_key")

    if not symbol:
        error_body = {
            "error": "Missing required 'symbol' parameter for technical analysis."
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
        logger.warning("Missing symbol, returning 400.")
        return response

    if not s3_key:
        error_body = {
            "error": "Missing required 's3_key' parameter (location of candle data)."
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
        logger.warning("Missing s3_key, returning 400.")
        return response

    df = _load_candles_from_s3(s3_bucket, s3_key)

    results: Dict[str, Any] = {
        "symbol": symbol,
        "source_file_bucket": s3_bucket,
        "source_file_key": s3_key,
        "indicators": {}
    }

    df["rsi"] = compute_rsi(df["close"], 14)
    last_rsi = float(df["rsi"].iloc[-1])
    results["indicators"]["RSI"] = {
        "value": last_rsi,
        "signal": interpret_rsi(last_rsi)
    }

    sma_short = 20
    sma_long = 50
    df["sma_short"] = df["close"].rolling(window=sma_short).mean()
    df["sma_long"] = df["close"].rolling(window=sma_long).mean()
    sma_s = float(df["sma_short"].iloc[-1])
    sma_l = float(df["sma_long"].iloc[-1])

    results["indicators"]["SMA"] = {
        "short_period": sma_short,
        "long_period": sma_long,
        "short_value": sma_s,
        "long_value": sma_l,
        "signal": interpret_trend(sma_s, sma_l)
    }

    df["ema_short"] = df["close"].ewm(span=sma_short, adjust=False).mean()
    df["ema_long"] = df["close"].ewm(span=sma_long, adjust=False).mean()
    ema_s = float(df["ema_short"].iloc[-1])
    ema_l = float(df["ema_long"].iloc[-1])

    results["indicators"]["EMA"] = {
        "short_period": sma_short,
        "long_period": sma_long,
        "short_value": ema_s,
        "long_value": ema_l,
        "signal": interpret_trend(ema_s, ema_l)
    }

    now = dt.datetime.utcnow()
    date_folder = now.strftime("%Y-%m-%d")
    base_name = os.path.basename(s3_key).replace(".json", "")

    output_key = f"indicators/{symbol}/{date_folder}/{base_name}_indicators.json"

    s3.put_object(
        Bucket=OUTPUT_BUCKET,
        Key=output_key,
        Body=json.dumps(results, indent=2).encode("utf-8"),
        ContentType="application/json"
    )

    logger.info(f"Indicators saved → s3://{OUTPUT_BUCKET}/{output_key}")

    response = {
        "messageVersion": "1.0",
        "response": {
            "actionGroup": event.get("actionGroup"),
            "apiPath": event.get("apiPath"),
            "httpMethod": event.get("httpMethod", "POST"),
            "httpStatusCode": 200,
            "responseBody": {
                "application/json": {
                    "body": {
                        "symbol": symbol,
                        "indicator_file_bucket": OUTPUT_BUCKET,
                        "indicator_file_key": output_key,
                        "indicators": results["indicators"]
                    }
                }
            }
        }
    }

    return response