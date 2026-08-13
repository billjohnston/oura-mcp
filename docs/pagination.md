# Collection pagination contract

Oura Cloud API v2 lists collections oldest-first with an opaque `next_token` cursor.
There is no integer page index and no page-size parameter.

## Agent loop

1. Call `oura_list_*` with `after` / `before` (and `limit` if you need a small context).
2. If `next_token` is present, call again with that same token and the same date window.
3. If `truncated` is true, `next_token` is omitted on purpose: raise `limit` or set
   `all_pages` instead of following a cursor. Resuming the upstream cursor would skip
   the records the local cap already fetched and dropped.
4. Stop when `has_more` is false.

Do not increment a `page` number. `page` / `next_page` were decorative and are gone.

## Flags

| Field | Meaning |
|---|---|
| `limit` | Local cap on returned rows, kept from the **oldest** end. Default 30, max 100. |
| `truncated` | The cap dropped rows that this call had already fetched. |
| `next_token` | Safe resume cursor. Present only when `truncated` is false and Oura still has a cursor. |
| `has_more` | More rows exist: either a resumable `next_token`, or `truncated`. |
| `all_pages` / `max_pages` | Follow the cursor inside this one call, up to the page budget. |

`limit: 1` is the oldest record in the window, never the newest. For readiness recency,
read `oura://latest/readiness`. For other domains, narrow `after` / `before` until
`truncated` and `has_more` are both false, then take the last record.
