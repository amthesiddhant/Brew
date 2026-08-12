# Brew — Access + Usage Web App

`Brew.gs` is a standalone Google Apps Script Web App that powers Brew for
**every** user, not just the person who owns the sheets.

## Why this exists

Brew used to read the access allowlist and write usage rows through the **DX
MCP Gateway**. The gateway authenticates as **each machine's own Google
account**, so it only ever worked for the sheet owner — the "App Access" and
"BrewUsage" sheets are private, and most users don't even have the gateway
installed (it's a developer tool).

A Web App deployed **"Execute as: Me"** runs with the *owner's* permissions
(full access to the private sheets) while **"Who has access: Anyone within
Salesforce.com"** lets any signed-in salesforce.com user reach it over plain
HTTPS. The caller's email comes from `Session.getActiveUser().getEmail()` —
authenticated by Google, unspoofable. No OAuth client, no token, no secret.

Brew authenticates by carrying the user's Google session cookies on the request
(see `../webapp.js`); a small sign-in window handles the one-time authorization
on first launch.

## Deploy (one-time, as the owner of both sheets)

1. Open <https://script.google.com> → **New project**.
2. Delete the default `Code.gs` and paste all of **`Brew.gs`**.
3. **Save** (name it e.g. `Brew Access + Usage`).
4. Function dropdown → **`setup`** → **Run**. Approve the Google authorization
   prompt. This ensures the `BrewUsage` header row and logs how many users the
   allowlist currently grants. (Optional: run `testCheckAccess` / `testLogUsage`.)
5. **Deploy → New deployment → Web app**:
   - **Execute as:** `Me`
   - **Who has access:** `Anyone within Salesforce.com`
6. Copy the **`/exec` URL** and paste it into
   [`../access-config.js`](../access-config.js) → `WEBAPP.execUrl`. It looks
   like `https://script.google.com/a/macros/salesforce.com/s/AKfycb.../exec`.

Until `WEBAPP.execUrl` is set, Brew's web-app calls are a safe no-op — the app
still ships and runs (access falls open via grace; usage sync skips).

## Re-deploying later

Edit the script → **Deploy → Manage deployments → ✏️ (edit) → Version: New
version → Deploy**. This keeps the **same `/exec` URL**. Creating a *new*
deployment mints a *new* URL (which then needs re-pasting into `access-config.js`).

## What each action does

| action        | reads / writes                                   | returns |
|---------------|--------------------------------------------------|---------|
| `checkAccess` | reads "App Access", matches caller's email       | `{ ok, allowed, email, reason }` |
| `logUsage`    | upserts one row per (Date + Email) in "BrewUsage"| `{ ok, action }` |
| `whoAmI`      | reads caller's **Role** in "App Access"          | `{ ok, email, role, isAdmin }` |
| `getUsage`    | **admins only** — reads ALL "BrewUsage" rows     | `{ ok, isAdmin, rows, count }` or `{ ok:false, error:'forbidden' }` |

All actions stamp/verify the caller identity **server-side** — the request body
cannot claim to be a different user.

### Admin (Team Usage) view

`getUsage` powers the dashboard's **Team Usage** table, which lets an admin see
every teammate's daily brewing. The admin decision is made **entirely
server-side**: the caller's Role comes from the "App Access" sheet's **Role**
column (`Admin` | `Owner` | `User` | `Viewer`), matched against their
Google-authenticated email. `Admin` and `Owner` may read everyone; `User` and
`Viewer` get `forbidden`. To grant/revoke admin, just edit the Role cell in the
sheet — no code change or redeploy.
