BEGIN;
\i database/ddl/000_schema.sql
\i database/ddl/010_administration.sql
\i database/ddl/020_master_data.sql
\i database/ddl/030_voucher_engine.sql
\i database/ddl/040_gl_stock.sql
\i database/ddl/051_bom_production.sql
\i database/ddl/060_sales_ar.sql
\i database/ddl/070_purchase_ap.sql
\i database/ddl/080_inventory.sql
\i database/ddl/050_production.sql
\i database/ddl/090_rgp_assets.sql
\i database/ddl/091_integrity_checks.sql
\i database/ddl/092_seeds.sql
COMMIT;
