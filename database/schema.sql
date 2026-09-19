-- AI Hospital Appointment System — Database Schema
-- Run this in Neon SQL Editor. For an existing DB, the ALTER/UPDATE statements
-- are safe migrations and can be run with the rest of this file.

CREATE TABLE IF NOT EXISTS doctors (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  specialization TEXT,
  active BOOLEAN DEFAULT true
);

-- Shown in the doctor's profile dropdown on the dashboard (photo,
-- qualification badges like "MBBS, MS") alongside name/specialization.
ALTER TABLE doctors ADD COLUMN IF NOT EXISTS qualification TEXT;
ALTER TABLE doctors ADD COLUMN IF NOT EXISTS photo_url TEXT;

-- Soft delete ("archive"). When admin deletes a doctor we no longer drop the
-- row — we stamp deleted_at, so every appointment/feedback row that points at
-- this doctor (ON DELETE CASCADE) survives and the admin can still read the
-- doctor's full history later, or restore them. A doctor with deleted_at set
-- is hidden from every normal list (patients, reception, slots, chatbot) and
-- only shows up in the admin's "Deleted Doctors" view.
ALTER TABLE doctors ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
ALTER TABLE doctors ADD COLUMN IF NOT EXISTS deleted_by TEXT;
ALTER TABLE doctors ADD COLUMN IF NOT EXISTS delete_reason TEXT;
CREATE INDEX IF NOT EXISTS doctors_deleted_at_idx ON doctors(deleted_at);

CREATE TABLE IF NOT EXISTS staff (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  password_display TEXT,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'reception', 'doctor')),
  doctor_id INT UNIQUE REFERENCES doctors(id) ON DELETE SET NULL
);

ALTER TABLE staff ADD COLUMN IF NOT EXISTS doctor_id INT;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS password_display TEXT;
-- Lets admin deactivate a staff login (used for reception accounts) without deleting it.
ALTER TABLE staff ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE staff DROP CONSTRAINT IF EXISTS staff_role_check;
ALTER TABLE staff ADD CONSTRAINT staff_role_check
  CHECK (role IN ('admin', 'reception', 'doctor'));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'staff_doctor_id_fkey'
  ) THEN
    ALTER TABLE staff
      ADD CONSTRAINT staff_doctor_id_fkey
      FOREIGN KEY (doctor_id) REFERENCES doctors(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS patients (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS slots (
  id SERIAL PRIMARY KEY,
  doctor_id INT REFERENCES doctors(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  time TIME NOT NULL,
  status TEXT DEFAULT 'available' CHECK (status IN ('available','booked'))
);

DELETE FROM slots a
USING slots b
WHERE a.id > b.id
  AND a.doctor_id = b.doctor_id
  AND a.date = b.date
  AND a.time = b.time;

CREATE UNIQUE INDEX IF NOT EXISTS slots_doctor_date_time_unique ON slots(doctor_id, date, time);

CREATE TABLE IF NOT EXISTS appointments (
  id SERIAL PRIMARY KEY,
  patient_id INT REFERENCES patients(id) ON DELETE CASCADE,
  doctor_id INT REFERENCES doctors(id) ON DELETE CASCADE,
  slot_id INT REFERENCES slots(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'booked' CHECK (status IN ('booked','arrived','attended','no_show')),
  chat_summary TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS chat_summary TEXT;
-- Full patient <-> chatbot conversation (every turn, not just the
-- sanitized one-line chat_summary) so admin/doctor can review exactly
-- what the patient typed before booking. NULL for appointments created
-- via manual entry (no chatbot conversation happened).
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS chat_transcript JSONB;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS booking_source TEXT DEFAULT 'chatbot';
ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_booking_source_check;
ALTER TABLE appointments ADD CONSTRAINT appointments_booking_source_check CHECK (booking_source IN ('chatbot', 'manual'));
-- Tracks whether the pre-visit WhatsApp reminder has already gone out for
-- this appointment, so the reminder job (see backend/server.js) never
-- sends the same reminder twice.
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS reminder_sent BOOLEAN DEFAULT false;
ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_status_check;
ALTER TABLE appointments ADD CONSTRAINT appointments_status_check
  CHECK (status IN ('booked','arrived','attended','no_show'));

CREATE TABLE IF NOT EXISTS feedback (
  id SERIAL PRIMARY KEY,
  appointment_id INT REFERENCES appointments(id) ON DELETE CASCADE UNIQUE,
  rating INT CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- MIGRATION (run this if you already have a live `feedback` table
-- WITHOUT a unique constraint on appointment_id — needed so one
-- appointment can't accidentally get two feedback rows, e.g. if a
-- patient double-submits or resubmits after a page refresh):
--
--   ALTER TABLE feedback ADD CONSTRAINT feedback_appointment_id_key UNIQUE (appointment_id);
--
-- If that fails because duplicates already exist, first keep only
-- the newest row per appointment_id:
--   DELETE FROM feedback f USING feedback f2
--   WHERE f.appointment_id = f2.appointment_id AND f.id < f2.id;
-- then re-run the ALTER TABLE above.
-- ============================================================

-- Demo/admin account. Password: admin123
INSERT INTO staff (username, password_hash, name, role)
VALUES ('admin',
        '$2b$10$HIr1IieXK9vjSvHw3SQ/De.ODrdH9y5I3mZXzBvlOnv83cCNPV5/G',
        'Admin', 'admin')
ON CONFLICT (username) DO NOTHING;
UPDATE staff SET password_display = 'admin123' WHERE username = 'admin' AND password_display IS NULL;

-- Reception account. Password: doctor123 (change before production).
INSERT INTO staff (username, password_hash, name, role)
VALUES ('reception',
        '$2b$10$57Uz04Ixf/5RVXiw1yuYqenKgLe5880XhZyB.c2xhkHZCg7i8zIqG',
        'Reception', 'reception')
ON CONFLICT (username) DO NOTHING;
UPDATE staff SET password_display = 'doctor123' WHERE username = 'reception' AND password_display IS NULL;

-- 12 demo doctors across different specializations.
INSERT INTO doctors (name, specialization, qualification)
SELECT v.name, v.specialization, v.qualification
FROM (VALUES
  ('Dr. Anil Sharma', 'General Physician', 'MBBS, MD'),
  ('Dr. Neha Verma', 'General Physician', 'MBBS, MD'),
  ('Dr. Rajiv Mehta', 'Cardiologist', 'MBBS, MD, DM (Cardiology)'),
  ('Dr. Priya Kapoor', 'Cardiologist', 'MBBS, MD, DM (Cardiology)'),
  ('Dr. Rohan Gupta', 'Dermatologist', 'MBBS, MD (Dermatology)'),
  ('Dr. Sneha Mishra', 'Dermatologist', 'MBBS, MD (Dermatology)'),
  ('Dr. Amit Singh', 'Pediatrician', 'MBBS, MD (Pediatrics)'),
  ('Dr. Kavya Joshi', 'Gynecologist', 'MBBS, MS (Obstetrics & Gynecology)'),
  ('Dr. Arjun Malhotra', 'Orthopedic', 'MBBS, MS (Orthopedics)'),
  ('Dr. Pooja Agarwal', 'ENT Specialist', 'MBBS, MS (ENT)'),
  ('Dr. Vivek Saxena', 'Neurologist', 'MBBS, MD, DM (Neurology)'),
  ('Dr. Nitin Bhatia', 'Gastroenterologist', 'MBBS, MD, DM (Gastroenterology)')
) AS v(name, specialization, qualification)
WHERE NOT EXISTS (
  SELECT 1 FROM doctors d WHERE d.name = v.name
);

-- Backfill qualification for any pre-existing demo rows created before this column existed.
UPDATE doctors SET qualification = 'MBBS, MD' WHERE name = 'Dr. Anil Sharma' AND qualification IS NULL;
UPDATE doctors SET qualification = 'MBBS, MD' WHERE name = 'Dr. Neha Verma' AND qualification IS NULL;
UPDATE doctors SET qualification = 'MBBS, MD, DM (Cardiology)' WHERE name = 'Dr. Rajiv Mehta' AND qualification IS NULL;
UPDATE doctors SET qualification = 'MBBS, MD, DM (Cardiology)' WHERE name = 'Dr. Priya Kapoor' AND qualification IS NULL;
UPDATE doctors SET qualification = 'MBBS, MD (Dermatology)' WHERE name = 'Dr. Rohan Gupta' AND qualification IS NULL;
UPDATE doctors SET qualification = 'MBBS, MD (Dermatology)' WHERE name = 'Dr. Sneha Mishra' AND qualification IS NULL;
UPDATE doctors SET qualification = 'MBBS, MD (Pediatrics)' WHERE name = 'Dr. Amit Singh' AND qualification IS NULL;
UPDATE doctors SET qualification = 'MBBS, MS (Obstetrics & Gynecology)' WHERE name = 'Dr. Kavya Joshi' AND qualification IS NULL;
UPDATE doctors SET qualification = 'MBBS, MS (Orthopedics)' WHERE name = 'Dr. Arjun Malhotra' AND qualification IS NULL;
UPDATE doctors SET qualification = 'MBBS, MS (ENT)' WHERE name = 'Dr. Pooja Agarwal' AND qualification IS NULL;
UPDATE doctors SET qualification = 'MBBS, MD, DM (Neurology)' WHERE name = 'Dr. Vivek Saxena' AND qualification IS NULL;
UPDATE doctors SET qualification = 'MBBS, MD, DM (Gastroenterology)' WHERE name = 'Dr. Nitin Bhatia' AND qualification IS NULL;

-- One login per doctor. Password for every demo doctor: doctor123.
INSERT INTO staff (username, password_hash, name, role, doctor_id)
SELECT
  'dr' || d.id,
  '$2b$10$57Uz04Ixf/5RVXiw1yuYqenKgLe5880XhZyB.c2xhkHZCg7i8zIqG',
  d.name,
  'doctor',
  d.id
FROM doctors d
WHERE d.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM staff s WHERE s.doctor_id = d.id AND s.role = 'doctor'
  );

-- Sample recurring-looking slots for the next 14 days.
-- Different doctors intentionally have different clinic hours.
INSERT INTO slots (doctor_id, date, time, status)
SELECT d.id, (CURRENT_DATE + gs.day_offset)::date, t::time, 'available'
FROM (SELECT * FROM doctors WHERE deleted_at IS NULL) d
CROSS JOIN generate_series(0, 13) AS gs(day_offset)
CROSS JOIN LATERAL (
  SELECT unnest(
    CASE
      WHEN d.id % 6 = 1 THEN ARRAY['09:00','09:30','10:00','10:30','11:00']
      WHEN d.id % 6 = 2 THEN ARRAY['11:00','11:30','12:00','12:30','13:00']
      WHEN d.id % 6 = 3 THEN ARRAY['14:00','14:30','15:00','15:30','16:00']
      WHEN d.id % 6 = 4 THEN ARRAY['16:00','16:30','17:00','17:30','18:00']
      WHEN d.id % 6 = 5 THEN ARRAY['10:00','10:30','11:00','11:30','12:00']
      ELSE ARRAY['18:00','18:30','19:00','19:30','20:00']
    END
  ) AS t
) x
WHERE NOT EXISTS (
  SELECT 1 FROM slots s
  WHERE s.doctor_id=d.id AND s.date=(CURRENT_DATE + gs.day_offset)::date AND s.time=t::time
);
