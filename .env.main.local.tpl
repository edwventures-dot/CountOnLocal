# Template for .env.main.local - 1Password references only, never values.
#
# Fill it in on any machine:  op inject --in-file countonlocal-main.tpl --out-file .env.main.local
# Values live in 1Password, vault "EDW", item "countonlocal-main", one field per key below.
# Safe to commit: every line here is a reference.

NEXT_PUBLIC_SUPABASE_URL="op://EDW/countonlocal-main/NEXT_PUBLIC_SUPABASE_URL"
NEXT_PUBLIC_SUPABASE_ANON_KEY="op://EDW/countonlocal-main/NEXT_PUBLIC_SUPABASE_ANON_KEY"
SUPABASE_SERVICE_ROLE_KEY="op://EDW/countonlocal-main/SUPABASE_SERVICE_ROLE_KEY"
AUDIT_IP_HASH_SALT="op://EDW/countonlocal-main/AUDIT_IP_HASH_SALT"
DATABASE_URL="op://EDW/countonlocal-main/DATABASE_URL"
STRIPE_SECRET_KEY="op://EDW/countonlocal-main/STRIPE_SECRET_KEY"
STRIPE_WEBHOOK_SECRET="op://EDW/countonlocal-main/STRIPE_WEBHOOK_SECRET"
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY="op://EDW/countonlocal-main/NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY"
CRON_SECRET="op://EDW/countonlocal-main/CRON_SECRET"
NOTIFICATIONS_PROVIDER_API_KEY="op://EDW/countonlocal-main/NOTIFICATIONS_PROVIDER_API_KEY"
NOTIFICATIONS_FROM_EMAIL="op://EDW/countonlocal-main/NOTIFICATIONS_FROM_EMAIL"
