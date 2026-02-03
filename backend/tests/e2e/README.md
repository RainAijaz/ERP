# E2E tests (Playwright)

## Setup

1) Install browsers once:
```
npm run test:e2e:install
```

2) Set credentials in PowerShell:
```
$env:E2E_ADMIN_USER="admin"
$env:E2E_ADMIN_PASS="password"
$env:E2E_MANAGER_USER="manager1"
$env:E2E_MANAGER_PASS="password"
$env:E2E_LIMITED_USER="ahsan"
$env:E2E_LIMITED_PASS="password"
```

Optional:
```
$env:E2E_BASE_URL="http://localhost:3000"
$env:E2E_ROLE_MANAGER="Manager"
$env:E2E_ROLE_SALESMAN="Salesman"
$env:E2E_USER_MANAGER="manager1"
$env:E2E_USER_SALESMAN="ahsan"
$env:E2E_MUTATE="1"
```

`E2E_MUTATE=1` enables tests that deactivate/reactivate users (concurrent session test).

3) Start the app (`npm run dev`) and run:
```
npm run test:e2e
```

## Route access checks

Edit `tests/e2e/route-access.json` to add routes to verify. Example:
```
{
  "routes": [
    {
      "name": "Parties list",
      "path": "/master-data/parties",
      "userPrefix": "E2E_LIMITED",
      "expectedStatus": 200,
      "denyText": "Permission denied"
    }
  ]
}
```
