BEGIN;
\ir database/ddl/000_schema.sql
\ir database/ddl/030_voucher_engine.sql
\ir database/ddl/010_administration.sql
\ir database/ddl/020_master_data.sql
\ir database/ddl/040_gl_stock.sql
\ir database/ddl/051_bom_production.sql
\ir database/ddl/060_sales_ar.sql
\ir database/ddl/070_purchase_ap.sql
\ir database/ddl/080_inventory.sql
\ir database/ddl/050_production.sql
\ir database/ddl/090_rgp_assets.sql
\ir database/ddl/091_integrity_checks.sql
\ir database/ddl/092_seeds.sql
COMMIT;
