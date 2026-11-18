# Deploying SvnAdmin

SvnAdmin manages a Subversion server that is served by **Apache httpd + mod_dav_svn**, using:

- an `AuthUserFile` in htpasswd format (`svn_users.passwd`), and
- an `AuthzSVNAccessFile` (`svn_access_control.authz`).

It runs as a Windows service on `127.0.0.1:5080`. Apache keeps HTTPS and forwards an admin host name (for example
`svnadmin.example.com`) to it. Your repository site (for example `svn.example.com`) doesn't change, and developers
keep using TortoiseSVN or the `svn` command line exactly as before.

The paths below use `C:\Subversion` and `C:\SvnAdmin`. Use whatever matches your server.

---

## 0. Before you start

1. **Back up** your passwd file, your authz file and `httpd.conf`.
2. **Find `svn.exe`, `svnadmin.exe` and `svnlook.exe`.** Use the same Subversion version as Apache's `mod_dav_svn`,
   so new repositories get a format Apache can read. They often sit in Apache's `bin` folder:
   ```powershell
   Get-ChildItem C:\ -Recurse -Filter svnadmin.exe -ErrorAction SilentlyContinue | Select FullName
   ```
3. Check which account the Apache service runs as (`services.msc` → Apache → Log On). SvnAdmin should run as the
   same account, because both read and write the passwd and authz files.
4. Decide which authz group holds your SVN administrators (`Svn:AdminGroup`, default `itadmins`). Make sure your own
   account is in it.
5. Optional: SMTP details for "forgot password" and welcome emails (any SMTP provider that supports STARTTLS or TLS).

## 1. Build (on a machine with the .NET 10 SDK and Node.js 22+)

```powershell
.\deploy\build.ps1
```

This runs the automated tests first and stops if any fail. It then produces `publish\`, which is self-contained,
so the server doesn't need .NET installed.

## 2. Copy and configure

1. Copy `publish\` to the server, for example as `C:\SvnAdmin\app\`.
2. Create `C:\SvnAdmin\app\appsettings.Local.json` for this server's settings. It is never overwritten by later
   deployments. Start from [`appsettings.Local.example.json`](appsettings.Local.example.json).

| Setting | Example | Notes |
|---|---|---|
| `Svn:ProductName` | `SVN Admin` | Shown in the UI, the authenticator app, passkey prompts and emails |
| `Svn:LogoFile` | `C:/SvnAdmin/logo.png` | Optional PNG/SVG/ICO. Empty = built-in logo |
| `Svn:AppUrl` | `https://svnadmin.example.com` | Used in email links |
| `Svn:PublicUrl` | `https://svn.example.com` | Checkout URL shown to users |
| `Svn:Passkeys:RelyingPartyId` | `svnadmin.example.com` | **Changing it later invalidates every passkey** |
| `Svn:Passkeys:Origins` | `["https://svnadmin.example.com"]` | Empty = `AppUrl` |
| `Svn:PasswdFile` / `AuthzFile` | `C:/Subversion/…` | The files Apache uses |
| `Svn:RepositoriesRoot` | `C:/Subversion/Repositories` | Apache's `SVNParentPath` |
| `Svn:ArchiveRoot` | `C:/Subversion/Archive` | Same drive as the repositories |
| `Svn:SvnBinDir` | `C:/Apache24/bin` | Folder with `svn.exe`, `svnadmin.exe`, `svnlook.exe`. Empty = PATH |
| `Svn:DatabasePath` | `C:/SvnAdmin/data/svnadmin.db` | Encryption keys go in `data/keys` next to it |
| `Svn:BackupRoot` | `C:/SvnAdmin/backups` | Config backup snapshots |
| `Svn:AdminGroup` | `itadmins` | Authz group whose members can use the admin pages |
| `Svn:RequireAdminMfa` | `true` | Admins must set up an authenticator app or passkey |
| `Svn:MinPasswordLength` | `10` | |
| `Svn:WelcomeLinkHours` / `ResetLinkMinutes` | `72` / `60` | |
| `AllowedHosts` | `svnadmin.example.com;localhost;127.0.0.1` | |

**Email** is set up in SvnAdmin itself: **System → Email**, with a **Send test email** button that tries the settings
before you save them. The SMTP password is stored encrypted in SvnAdmin's database and never shown again. An `Email`
section in `appsettings.Local.json` also works, as a fallback.

## 3. Install the service

From an **elevated** PowerShell:

```powershell
cd C:\SvnAdmin\app
.\install-service.ps1 -DataDir C:\SvnAdmin\data -SvnDirs C:\Subversion, C:\SvnAdmin\backups
```

On first start SvnAdmin **imports** the current passwd and authz files. Lines it couldn't import (aliases, `~` rules,
group members with no account) are logged in **Event Viewer → Application** and in the audit log.

Check it's running: `Invoke-RestMethod http://127.0.0.1:5080/api/health` → `ok: True`.

## 4. Point Apache at it

Follow [`apache-svnadmin.conf`](apache-svnadmin.conf):

1. Enable `headers_module`, `proxy_module` and `proxy_http_module` in `httpd.conf`.
2. Add (or replace) the `<VirtualHost *:443>` for your admin host name with the block in that file.
3. Run `httpd.exe -t`. It must say `Syntax OK`.
4. Restart Apache.

## 5. First sign-in (set up two-step sign-in)

1. Open your admin URL and sign in with an account in the admin group.
2. You land on **My account** with a banner: admins must add a second step before the admin pages unlock.
   - **Passkey** (recommended): click **Add passkey** and use Windows Hello, your phone, or a security key.
   - **Authenticator app**: click **Set up**, scan the QR code, and type the 6-digit code.
3. **Save the recovery codes** it shows. They're how you get back in without your phone. Another admin can also
   reset your two-step sign-in from the Users page.
4. On **Users**, add your email address. Then on **System → Email**, enter your SMTP details, press
   **Send test email**, and **Save**.

## 6. Check

1. **System** page: both files say *imported* or *in sync*, the SVN tools say *found*, and email says *On*.
2. Make a harmless change (for example a group description), then check a developer can still update a working copy.
3. Tell developers they can now sign in with their SVN username and password to change it (**My account**), see which
   repositories they can use, and use **Forgot password?** on the sign-in page if they have an email address.

## Updating later

Run `build.ps1` again (tests run first), then on the server:

```powershell
Stop-Service SvnAdmin
robocopy C:\path\to\publish C:\SvnAdmin\app /MIR /XF appsettings.Local.json
Start-Service SvnAdmin
```

The database migrates itself on start. Don't delete `data\keys`: it holds the keys that encrypt authenticator
secrets and sign-in cookies.

## How it stays in step with other tools

- **Hand edits to authz**: SvnAdmin detects them and *stops saving* until an admin chooses, on **System**, to
  re-import (keep the edit) or overwrite (discard it). Nothing is lost silently.
- **Password changes made directly in the passwd file** (for example by `htpasswd`) are picked up and logged as
  `user.password.external`.
- **Repositories created by hand** under `RepositoriesRoot` show up automatically.
- Every replaced passwd/authz file is kept in `ConfigHistoryDir` (last 200 by default).
- The **inactive accounts** report reads `svn log` once an hour, picking up only new revisions after the first scan.

## Rolling back

1. Stop the SvnAdmin service.
2. Put your original VirtualHost block back in `httpd.conf` and restart Apache.
3. If needed, copy the passwd/authz files back from `ConfigHistoryDir`.

SvnAdmin never deletes repositories: archiving only moves the folder to `ArchiveRoot`.

## Config backups

The **Config backups** page takes a daily snapshot (on by default, 02:00 server time, last 30 kept) of:

- the passwd file: accounts and password hashes
- the authz file: groups and folder permissions
- `svnadmin.db`: SvnAdmin's database (taken with SQLite `VACUUM INTO`, so it's consistent while running)

Snapshots are saved in `BackupRoot\config\<yyyy-MM-dd_HH-mm-ss>\`, and each one can be downloaded as a zip.
These are *configuration* backups only. Back up the repositories themselves with your usual tool
(`svnadmin hotcopy`, file-level backups, and so on).

**Restore** (button on each snapshot) puts back SVN access as it was then: passwords, which accounts are enabled,
groups and folder permissions. It rewrites the live passwd and authz files at once. Names, emails, two-step
sign-in and the audit log are not changed. It takes a snapshot of the current state first, so a restore can be
undone by restoring that one. It refuses to run if the snapshot would remove you from the admin group.

For a full disaster recovery (for example, a lost SvnAdmin database), restore all three files by hand:

```powershell
$s = 'C:\SvnAdmin\backups\config\<snapshot>'
Stop-Service SvnAdmin
Copy-Item "$s\svn_users.passwd", "$s\svn_access_control.authz" C:\Subversion\
Copy-Item "$s\svnadmin.db" C:\SvnAdmin\data\svnadmin.db
Remove-Item C:\SvnAdmin\data\svnadmin.db-wal, C:\SvnAdmin\data\svnadmin.db-shm -ErrorAction SilentlyContinue
Start-Service SvnAdmin
```

Keep `data\keys` with the database. Without it, saved authenticator-app setups can't be read and admins must set up
two-step sign-in again.
