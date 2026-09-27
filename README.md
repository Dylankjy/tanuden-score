# Tanuden Score

Rudolf-native drive scoring service. Ingests live telemetry from the desktop console over Socket.io, evaluates drives, and serves stats / records / rankings over REST (paths mirror tanuden-myuntendai's for a low-friction UI cutover).

## Deletion sync (account deletion feed)

`src/jobs/deletion-sync.job.ts` polls tanuden-auth's internal `GET /rpc/deletion-events?since=<cursor>` once a minute (authenticated with `x-internal-secret`). Each event means "this account has been anonymized" — the job runs a local, **idempotent** cleanup action per event and checkpoints the last processed event id in this service's own `deletion_cursor` collection. Auth being unreachable skips a cycle; nothing is lost, the events are re-served on a later poll.

Score data itself carries no direct identifiers (only the user `_id`), so today's action is a logged no-op — the hook exists for any future per-user derived state.

## Configuration

Copy `example.env` to `.env`. Deletion-sync additions:

| Variable | Purpose |
| --- | --- |
| `INTERNAL_SECRET` | Shared gateway/upstream secret — sent as `x-internal-secret` when polling auth's feed. Must match the gateway. |
| `AUTH_SERVICE_URL` | tanuden-auth base URL (direct, not via the gateway). |
