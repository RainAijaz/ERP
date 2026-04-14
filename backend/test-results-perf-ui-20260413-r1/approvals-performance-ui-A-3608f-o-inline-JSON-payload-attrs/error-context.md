# Page snapshot

```yaml
- generic [active] [ref=e1]: select "ar"."id", "ar"."entity_type", "ar"."entity_id", "ar"."request_type", "ar"."action", "ar"."status", "ar"."summary", "ar"."requested_at", "ar"."decided_at", "u"."username" as "requester_name" from "erp"."approval_request" as "ar" left join "erp"."users" as "u" on "ar"."requested_by" = "u"."id" where "ar"."status" = $1 order by "ar"."requested_at" desc limit $2 - column ar.action does not exist
```