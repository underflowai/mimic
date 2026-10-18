-- Production's enum predates the migration journal (an early drizzle-kit push) and never
-- received 'cancelled', so every DELETE /calls/:id failed with a 500 before it could end
-- the call. Databases created from 0000 already have the value; IF NOT EXISTS keeps this a no-op there.
ALTER TYPE "public"."call_status" ADD VALUE IF NOT EXISTS 'cancelled';
