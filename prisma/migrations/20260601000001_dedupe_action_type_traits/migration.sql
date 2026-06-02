-- Remove duplicate rows in action_type_traits, keeping the lowest id per (device_action_type_id, google_trait_id) pair
DELETE FROM "action_type_traits"
WHERE id NOT IN (
  SELECT MIN(id)
  FROM "action_type_traits"
  GROUP BY device_action_type_id, google_trait_id
);

-- Prevent future duplicates
ALTER TABLE "action_type_traits"
  ADD CONSTRAINT "action_type_traits_device_action_type_id_google_trait_id_key"
  UNIQUE (device_action_type_id, google_trait_id);
