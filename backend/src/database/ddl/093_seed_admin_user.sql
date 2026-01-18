-- =====================================================================
-- 093_seed_admin_user.sql
-- PURPOSE:
--   Create a default admin user and assign to first available branch.
-- NOTE:
--   - Username: admin
--   - Password: admin123 (change immediately)
-- =====================================================================

SET search_path = erp;

INSERT INTO erp.users (username, password_hash, primary_role_id, status)
SELECT
  'admin',
  ':e0ab1c19eaf565c27dfe36e413206c889beff73bfaf7b9bcac856b39bf54912aa93c88cbe153aa7e62b842e6426d54909a3632f9b0ffd4731e41e82cbf06c6fc',
  r.id,
  'Active'
FROM erp.role_templates r
WHERE lower(trim(r.name)) = 'admin'
ON CONFLICT (username) DO NOTHING;

INSERT INTO erp.user_branch (user_id, branch_id)
SELECT u.id, b.id
FROM erp.users u
JOIN erp.branches b ON true
WHERE u.username = 'admin'
ON CONFLICT DO NOTHING;
