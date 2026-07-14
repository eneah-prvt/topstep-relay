"""
Drop-in signal sender for your friend's algo (Python).
Call send_signal(...) wherever the algo decides to enter/exit a trade.

If the algo is NOT Python, the only thing that matters is that it makes the
same HTTP POST — see send_signal.sh (curl) and the README for other platforms.
"""

import os
import uuid
import requests

RELAY_URL = os.environ.get("RELAY_URL", "https://your-relay.up.railway.app")
SENDER_SECRET = os.environ.get("SENDER_SECRET", "change-me-long-random-string")


def send_signal(symbol, side, size, order_type="MARKET",
                stop_loss_ticks=None, take_profit_ticks=None,
                limit_price=None, stop_price=None, signal_id=None):
    payload = {
        "signalId": signal_id or str(uuid.uuid4()),
        "symbol": symbol,
        "side": side,                 # "LONG" or "SHORT"
        "size": size,
        "orderType": order_type,      # MARKET / LIMIT / STOP / TRAILINGSTOP
        "limitPrice": limit_price,
        "stopPrice": stop_price,
        "stopLossTicks": stop_loss_ticks,
        "takeProfitTicks": take_profit_ticks,
    }
    resp = requests.post(
        f"{RELAY_URL.rstrip('/')}/signal",
        json=payload,
        headers={"x-secret": SENDER_SECRET},
        timeout=10,
    )
    print("relay:", resp.status_code, resp.text)
    resp.raise_for_status()
    return resp.json()


if __name__ == "__main__":
    # Example: go long 2 NQ, 40-tick stop, 80-tick target.
    send_signal("NQ", "LONG", 2, stop_loss_ticks=40, take_profit_ticks=80)
