-- 016 — Two limits on complimentary courses.
--
-- 1. One complimentary course per offer per paid admission. An offer that lists several complimentary
--    courses lets the learner pick one of them, not all. All versions of an offer (same offer_code)
--    count as the same offer.
-- 2. A complimentary course can't be one the person already has an admission for (paid or free).
--
-- Cancelled admissions don't count for either rule, so cancelling a wrongly granted course frees the
-- slot again. Existing admissions are left as they are; the rules apply to new admissions.
--
-- Depends on: 015_offer_once_per_person.sql

CREATE FUNCTION check_complimentary_rules() RETURNS TRIGGER AS $$
DECLARE
    v_existing TEXT;
BEGIN
    IF NEW.complimentary_of_admission_id IS NULL THEN
        RETURN NEW;
    END IF;

    -- Same lock as the offer-once rule: concurrent admissions for one person run one at a time.
    PERFORM pg_advisory_xact_lock(hashtext('offer-once-per-person'), NEW.person_id);

    SELECT a.admission_code INTO v_existing
    FROM admissions a
    JOIN offers o ON o.offer_id = a.offer_id
    WHERE a.complimentary_of_admission_id = NEW.complimentary_of_admission_id
      AND a.enrolment_status <> 'Cancelled'
      AND o.offer_code = (SELECT offer_code FROM offers WHERE offer_id = NEW.offer_id)
    ORDER BY a.admission_id
    LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION 'This offer has already given a complimentary course on this admission (%); an offer gives one complimentary course per admission',
            v_existing;
    END IF;

    SELECT a.admission_code INTO v_existing
    FROM admissions a
    WHERE a.person_id = NEW.person_id AND a.course_id = NEW.course_id AND a.enrolment_status <> 'Cancelled'
    ORDER BY a.admission_id
    LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION 'This learner already has this course (admission %); a complimentary course must be one they don''t have',
            v_existing;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- "zz_" so it runs after trg_admissions_before_insert (fills person_id from the main admission) and after
-- trg_admissions_z_offer_once, whose "offer already used" message is the more useful one when both apply.
CREATE TRIGGER trg_admissions_zz_complimentary_rules
    BEFORE INSERT ON admissions
    FOR EACH ROW EXECUTE FUNCTION check_complimentary_rules();
