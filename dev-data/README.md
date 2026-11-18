# Local test data (development only)

Sample SVN config used when running SvnAdmin with `ASPNETCORE_ENVIRONMENT=Development`.
Nothing here is used on the server. Delete `svnadmin.db*` to start over from the files.

| User     | Password        | Hash format | Notes                    |
|----------|-----------------|-------------|--------------------------|
| devadmin | `DevAdmin#2026` | $apr1$      | member of `itadmins`     |
| carol    | `DevAdmin#2026` | $apr1$      | not an admin             |

The other sample users (bob, erin, frank, heidi, ivan) have random passwords. Reset them from the Users page
if you need to sign in as them.

`devadmin` is an admin, so the first sign-in asks you to set up two-step sign-in (an authenticator app or a passkey).
Use `http://localhost:5080` (not 127.0.0.1) so passkeys work. Emails are written to `dev-data/mail/*.eml` instead of being sent.

To try the import warnings, add something SvnAdmin does not support to `svn_access_control.authz`
(an alias, an inverted rule such as `~@qa`, or a group member with no passwd entry) and delete `svnadmin.db*`.
