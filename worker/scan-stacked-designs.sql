-- FIND SAVED DESIGNS THAT WERE OVER-QUOTED BY STACKED ITEMS.
--
-- Until the designer was fixed, addShelf and addVent placed every new item at
-- the SAME default coordinate. Tap "Add shelf" four times and you got four
-- records in one place: one board on the shed, four lines on the invoice.
-- Design 027f6936 held four shelves (three identical) and two identical
-- vents, and was quoted $330 over.
--
-- Run this in the Cloudflare D1 console against the shed database. It is a
-- single SELECT -- it reads, it changes nothing.
--
-- ghost_shelves / ghost_vents is how many were billed and could not be seen.
-- To price the damage on any code it returns:
--     https://potentia-assistant.thepotentianetwork.workers.dev/shed/design/<code>
-- and run the config through computePricing twice, once as saved and once
-- with exact-duplicate records removed.
--
-- Exact matches only, deliberately. Two shelves an inch apart are a choice,
-- however odd; two at the identical coordinate are one shelf and a billing
-- error.

WITH sh AS (
  SELECT d.code,
         json_extract(j.value,'$.wall')||'|'||json_extract(j.value,'$.pos')||'|'||
         json_extract(j.value,'$.cy')||'|'||json_extract(j.value,'$.depth')||'|'||
         json_extract(j.value,'$.len') AS sig
  FROM saved_designs d, json_each(json_extract(d.config,'$.shelves')) j
), vt AS (
  SELECT d.code,
         json_extract(j.value,'$.wall')||'|'||json_extract(j.value,'$.pos')||'|'||
         json_extract(j.value,'$.cy') AS sig
  FROM saved_designs d, json_each(json_extract(d.config,'$.vents')) j
), agg AS (
  SELECT d.code, d.contact_name, d.contact_email, d.created_at,
         (SELECT COUNT(*)          FROM sh WHERE sh.code=d.code) AS shelves_saved,
         (SELECT COUNT(DISTINCT sig) FROM sh WHERE sh.code=d.code) AS shelves_real,
         (SELECT COUNT(*)          FROM vt WHERE vt.code=d.code) AS vents_saved,
         (SELECT COUNT(DISTINCT sig) FROM vt WHERE vt.code=d.code) AS vents_real
  FROM saved_designs d
)
SELECT code, contact_name, contact_email, created_at,
       shelves_saved, shelves_real, (shelves_saved-shelves_real) AS ghost_shelves,
       vents_saved,   vents_real,   (vents_saved-vents_real)     AS ghost_vents
FROM agg
WHERE shelves_saved > shelves_real OR vents_saved > vents_real
ORDER BY created_at DESC;
