BEGIN;
\i database/ddl/000_schema.sql
\i database/ddl/010_foundation.sql
\i database/ddl/020_master_data.sql
\i database/ddl/030_voucher_engine.sql
\i database/ddl/040_gl_stock.sql
\i database/ddl/050_bom_production.sql
\i database/ddl/060_sales_ar.sql
\i database/ddl/070_purchase_ap.sql
\i database/ddl/080_inventory_stockcount.sql
\i database/ddl/090_rgp_assets.sql
COMMIT;
