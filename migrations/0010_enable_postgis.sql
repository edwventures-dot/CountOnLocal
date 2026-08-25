-- 0010  Enable PostGIS.
--
-- Deliberately alone in its own migration. The runner sends each file as a
-- single batch, and Postgres parses every statement in a batch before
-- executing any of them -- so a file that creates an extension and then
-- declares a column of a type that extension provides fails at parse time
-- with "type geography does not exist".
--
-- Rule of thumb for this project: anything that introduces a new TYPE other
-- statements depend on gets its own migration file.

create extension if not exists postgis;
