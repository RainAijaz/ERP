# Page snapshot

```yaml
- generic [active] [ref=e1]: select "r"."id", "r"."labour_id", "r"."dept_id", "r"."apply_on", "r"."sku_id", "r"."subgroup_id", "r"."group_id", "r"."rate_type", "r"."rate_value", "r"."article_type" from "erp"."labour_rate_rules" as "r" left join "erp"."labours" as "l" on "l"."id" = "r"."labour_id" left join "erp"."departments" as "d" on "d"."id" = "r"."dept_id" where lower(trim(COALESCE(r.status, ''))) = 'active' and "r"."applies_to_all_labours" = $1 and "r"."labour_id" is not null and lower(trim(COALESCE(l.status, ''))) = 'active' and "d"."is_active" = $2 and "d"."is_production" = $3 - column r.article_type does not exist
```