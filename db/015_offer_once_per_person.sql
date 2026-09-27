-- 015 — An offer can be used only once per person.
--
-- A person "uses" an offer when an admission applies it: as the offer on the admission's fee version
-- (discount offers) or as the offer granting a complimentary admission. All versions of an offer
-- (same offer_code) count as the same offer. Complimentary admissions granted on top of the same paid
-- admission are one redemption. Cancelled admissions don't count, so the offer is available again
-- if the admission that used it is cancelled.
--
-- Depends on: 014_lead_intake_sync_genuine.sql

-- Every non-cancelled redemption of an offer by a person.
CREATE VIEW person_offer_redemptions AS
SELECT a.person_id,
       o.offer_code,
       o.offer_id,
       a.admission_id,
       a.admission_code,
       COALESCE(a.complimentary_of_admission_id, a.admission_id) AS redemption_admission_id,
       CASE WHEN a.complimentary_of_admission_id IS NULL THEN 'Fee offer' ELSE 'Complimentary course' END AS used_as,
       a.admission_date
FROM admissions a
JOIN fee_discussion_versions v ON v.version_id = a.fee_version_id
JOIN offers o ON o.offer_id = v.offer_id
WHERE a.enrolment_status <> 'Cancelled'
UNION ALL
SELECT a.person_id,
       o.offer_code,
       o.offer_id,
       a.admission_id,
       a.admission_code,
       COALESCE(a.complimentary_of_admission_id, a.admission_id),
       'Complimentary course',
       a.admission_date
FROM admissions a
JOIN offers o ON o.offer_id = a.offer_id
WHERE a.enrolment_status <> 'Cancelled';

COMMENT ON VIEW person_offer_redemptions IS
    'Offers already used by each person (one row per admission applying the offer); cancelled admissions excluded';

CREATE FUNCTION check_offer_once_per_person() RETURNS TRIGGER AS $$
DECLARE
    v_codes TEXT[];
    v_used RECORD;
BEGIN
    -- Offers this admission applies (fee version offer and / or complimentary offer).
    SELECT ARRAY_AGG(DISTINCT o.offer_code) INTO v_codes
    FROM offers o
    WHERE o.offer_id IN (
        (SELECT v.offer_id FROM fee_discussion_versions v WHERE v.version_id = NEW.fee_version_id),
        NEW.offer_id
    );
    IF v_codes IS NULL THEN
        RETURN NEW;
    END IF;

    -- Serialise admissions for the same person so two concurrent ones can't both use the offer.
    PERFORM pg_advisory_xact_lock(hashtext('offer-once-per-person'), NEW.person_id);

    SELECT r.offer_code, r.admission_code INTO v_used
    FROM person_offer_redemptions r
    WHERE r.person_id = NEW.person_id
      AND r.offer_code = ANY (v_codes)
      AND r.redemption_admission_id <> COALESCE(NEW.complimentary_of_admission_id, NEW.admission_id)
    ORDER BY r.admission_id
    LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION 'Offer % has already been used by this person (admission %); an offer can be used only once per person',
            v_used.offer_code, v_used.admission_code;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- "z_" so it runs after trg_admissions_before_insert has filled person_id and fee_version_id from the invoice.
CREATE TRIGGER trg_admissions_z_offer_once
    BEFORE INSERT ON admissions
    FOR EACH ROW EXECUTE FUNCTION check_offer_once_per_person();
