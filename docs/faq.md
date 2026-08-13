# FAQ

## Is this official?

No. It is unofficial and not affiliated with Oura.

## What data can it read?

Readiness, daily activity, sleep periods, heart-rate records, HRV, SpO2, workouts, sessions, tags and personal info when granted.

## Does it provide raw sensor data?

No raw accelerometer/device telemetry. `raw` mode means upstream Oura Cloud API v2 JSON for supported endpoints.

## How do collection tools paginate?

Oura v2 uses an opaque `next_token` cursor, not a page number. Pass `next_token` back
when it is present. If `truncated` is true, raise `limit` or set `all_pages` — do not
invent a page index. See [pagination.md](pagination.md).

## Is it medical advice?

No. It provides wellness/training context only.
