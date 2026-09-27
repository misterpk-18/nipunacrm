-- Reset every serial sequence to MAX(id) + 1 of its table.
-- Rolled-back test inserts still consume sequence values; run this after testing so real IDs start clean.
-- Usage: psql -d nipunacrm -q -f .claude/skills/db-migration/scripts/reset_sequences.sql
DO $$
DECLARE
    r RECORD;
    v BIGINT;
BEGIN
    FOR r IN
        SELECT s.oid AS seq, t.relname AS tbl, a.attname AS col
        FROM pg_class s
        JOIN pg_depend d ON d.objid = s.oid AND d.deptype = 'a'
        JOIN pg_class t ON t.oid = d.refobjid
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
        WHERE s.relkind = 'S'
    LOOP
        EXECUTE format('SELECT COALESCE(MAX(%I), 0) FROM %I', r.col, r.tbl) INTO v;
        PERFORM setval(r.seq::regclass, v + 1, false);
    END LOOP;
END $$;

-- Row counts for a quick look: rollback-only tests leave these unchanged (all 0 until real data exists)
SELECT 'leftover test rows: ' || ((SELECT count(*) FROM users) + (SELECT count(*) FROM leads)
       + (SELECT count(*) FROM payments) + (SELECT count(*) FROM number_sequences)) AS check;
