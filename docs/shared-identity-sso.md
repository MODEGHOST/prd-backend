# Shared Identity — `shared_auth.Center_user_lfb`

Central SSO table for all LFB apps. **No app roles** live here.

| System | Identity | Access / roles |
|---|---|---|
| Center | `shared_auth.Center_user_lfb` | username, password, email, telegram_id, department, status |
| PRD | `lfbsmart_project.users` (local profile, same `id`) | `company_memberships` + RBAC |
| CMS | `cms.users` (local profile, same `id`) | `cms.cms_memberships` (admin\|staff) |

## Setup

```bash
# From cms-backend (creates DB + copies from lfbsmart_project.users)
npm run db:migrate-center-user
```

Env (both backends):

```
SHARED_DB_NAME=shared_auth
CENTER_USER_TABLE=Center_user_lfb
```
