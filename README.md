# Captain Spurling Hub

One Express service that hosts the four Starship V programs under paths on
captain.spurling.net, with one sign-in for the whole hub:

| Path | Program |
| --- | --- |
| `/` | Landing page, the home screen after sign-in |
| `/inventory` | Par Inventory |
| `/cash` | Petty Cash |
| `/maintenance` | Maintenance Tracker |
| `/tides` | Tide Chart |

## Sign-in

A single `APP_PASSWORD` env var protects everything, including the landing
page. Signing in sets one signed cookie (`svhub`, 30 days) at path `/`, so
one sign-in opens all four programs. Each program header also has an
"All programs" link back to `/` and a "Sign out" link.

## Storage

One `DATABASE_URL` pointing at the existing shared Postgres
(`starship-v-par-db`). There is no database resource in `render.yaml`; set
`DATABASE_URL` by hand to that database's connection string.

- Inventory uses the table name and schema of the live standalone Par
  Inventory app (table `items`, created only if missing, seeded only when
  empty), so it reads the live data: the 64 items and any counts already
  entered. Do not rename its tables.
- Petty Cash uses `pc_meta`, `pc_transactions`, `pc_receipts`, `pc_audits`,
  seeded from `seeds/cash.json` on first run when its tables are empty.
- Maintenance uses `mt_items`, `mt_logs`, `mt_hours`, seeded from
  `seeds/maintenance.json` on first run when its tables are empty.
- Tides stores nothing; it fetches NOAA predictions server side and caches
  them in memory for about 6 hours.

## Local development

With no `DATABASE_URL`, each data module falls back to a JSON file store in
`data/` (`data/inventory.json`, `data/cash.json`, `data/maintenance.json`),
seeded fresh from `seeds/` on first run. Delete the `data/` directory to
reset. Run with:

```
APP_PASSWORD=test REPORT_TOKEN=test-token npm start
```

## Monday report feeds

All three feeds are protected by the single `REPORT_TOKEN` env var and
return the same JSON shapes as the standalone apps:

- `GET /inventory/api/report.json?token=<REPORT_TOKEN>`
- `GET /cash/api/statement.json?token=<REPORT_TOKEN>`
- `GET /maintenance/api/report.json?token=<REPORT_TOKEN>`

## Deploy

Render Blueprint from this repo's `render.yaml` creates one web service,
`captain-hub` (Starter). Set `APP_PASSWORD` and `DATABASE_URL` (the shared
database's connection string) in the dashboard; `REPORT_TOKEN` is
generated. Add the custom domain `captain.spurling.net` to the service; no
subdomains are needed because the programs live under paths.
