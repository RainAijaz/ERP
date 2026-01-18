BEGIN;
\ir 000_schema.sql
\ir 010_administration.sql
\ir 020_master_data.sql
\ir 030_voucher_engine.sql
\ir 040_gl_stock.sql
\ir 051_bom_production.sql
\ir 060_sales_ar.sql
\ir 070_purchase_ap.sql
\ir 080_inventory.sql
\ir 050_production.sql
\ir 090_rgp_assets.sql
\ir 091_integrity_checks.sql
\ir 092_seeds.sql
\ir 093_seed_admin_user.sql
COMMIT;
