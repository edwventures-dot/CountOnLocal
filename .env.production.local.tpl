# Template for .env.production.local - 1Password references only, never values.
#
# Fill it in on any machine:  op inject --in-file countonlocal-production.tpl --out-file .env.production.local
# Values live in 1Password, vault "EDW", item "countonlocal-production", one field per key below.
# Safe to commit: every line here is a reference.

DATABASE_URL="op://EDW/countonlocal-production/DATABASE_URL"
