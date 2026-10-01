-- Engine-facing columns: policy version label (text) and executor payload.
ALTER TABLE actions ADD COLUMN policy_version text NOT NULL DEFAULT '';
ALTER TABLE actions ADD COLUMN payload jsonb;
