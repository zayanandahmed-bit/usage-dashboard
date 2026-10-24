# DaysBack AI usage dashboard

Live token use and spend for your Anthropic account.

- `docs/index.html`: the dashboard (GitHub Pages). No secrets in it.
- `supabase/functions/daysback-usage/`: reads Anthropic's usage report with a key that lives only in Supabase.

Secrets (Supabase > Edge Functions > Secrets): `ANTHROPIC_ADMIN_KEY`, `USAGE_PASSCODE`.
Preview with fake data: add `?demo=1` to the page address.
