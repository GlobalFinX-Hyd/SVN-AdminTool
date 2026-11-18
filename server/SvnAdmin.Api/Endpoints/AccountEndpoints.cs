using System.Text.Json;
using Dapper;
using Microsoft.Extensions.Options;
using SvnAdmin.Data;
using SvnAdmin.Security;
using SvnAdmin.Services;
using SvnAdmin.Svn;

namespace SvnAdmin.Endpoints;

/// <summary>
/// "My account" for every SVN user (self-service): change password,
/// authenticator app, recovery codes, passkeys, and what I can access.
/// Also the public "forgot password" and "set password from an emailed link" endpoints.
/// </summary>
public static class AccountEndpoints
{
    public sealed record ChangePasswordRequest(string CurrentPassword, string NewPassword);
    public sealed record CodeRequest(string Code);
    public sealed record PasswordConfirm(string Password);
    public sealed record PasskeyRegisterRequest(string Handle, JsonElement Credential, string? Name);
    public sealed record RenameRequest(string? Name);
    public sealed record ForgotRequest(string Login);
    public sealed record SetPasswordRequest(string Token, string Password);

    public static void MapAccount(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/account");

        g.MapGet("/", (HttpContext ctx, Db db, Passkeys passkeys, IOptions<SvnOptions> opt) =>
        {
            var name = ctx.User.Identity!.Name!;
            using var conn = db.Open();
            var u = conn.QuerySingle<(long Id, string Username, string FullName, string Email, string? PasswordChangedAt, string? LastLoginAt)>(
                "SELECT id, username, full_name, email, password_changed_at, last_login_at FROM users WHERE username = @name", new { name });
            var groups = Lookups.EffectiveGroups(conn, null, name).OrderBy(x => x, StringComparer.OrdinalIgnoreCase).ToList();
            return new
            {
                u.Username, u.FullName, u.Email, u.PasswordChangedAt, u.LastLoginAt, groups,
                hasTotp = Mfa.HasTotp(conn, null, u.Id),
                recoveryCodesLeft = Mfa.RecoveryCodesLeft(conn, null, u.Id),
                passkeys = passkeys.List(u.Id),
                access = AccessFor(conn, name, opt.Value.PublicUrl),
            };
        });

        g.MapPost("/password", (ChangePasswordRequest req, HttpContext ctx, ConfigSync sync, IOptions<SvnOptions> opt) =>
        {
            var actor = Actor.From(ctx);
            Lookups.ValidatePassword(req.NewPassword, actor.Name, opt.Value.MinPasswordLength);
            if (req.NewPassword == req.CurrentPassword) throw new AppException("The new password must be different from the current one.");
            sync.Mutate(actor, (conn, tx) =>
            {
                var hash = conn.ExecuteScalar<string>("SELECT password_hash FROM users WHERE username = @n", new { n = actor.Name }, tx);
                if (!HtpasswdHash.Verify(req.CurrentPassword ?? "", hash ?? "")) throw new AppException("Current password is incorrect.");
                var now = Clock.Now();
                conn.Execute("UPDATE users SET password_hash = @h, password_changed_at = @now, updated_at = @now WHERE username = @n",
                    new { h = HtpasswdHash.Create(req.NewPassword), now, n = actor.Name }, tx);
                Audit.Write(conn, tx, actor, "user.password.self", actor.Name);
            });
            return Results.NoContent();
        });

        // ---- authenticator app
        g.MapPost("/totp/setup", (HttpContext ctx, Mfa mfa) => mfa.BeginTotp(ctx.User.Identity!.Name!));

        g.MapPost("/totp/confirm", async (CodeRequest req, HttpContext ctx, Db db, Mfa mfa) =>
        {
            var actor = Actor.From(ctx);
            List<string>? codes;
            using (var conn = db.Open())
            {
                var id = Lookups.UserId(conn, null, actor.Name);
                using var tx = conn.BeginTransaction();
                codes = mfa.ConfirmTotp(conn, tx, id, actor.Name, req.Code ?? "");
                if (codes is null) throw new AppException("That code didn't match. Check the time on your phone is right and try the newest code.");
                Audit.Write(conn, tx, actor, "mfa.totp.enabled", actor.Name);
                tx.Commit();
            }
            await Sessions.SignInAsync(ctx, actor.Name, mfa: true); // they've just proven the second factor
            return Results.Ok(new { recoveryCodes = codes, me = Sessions.BuildMe(ctx) });
        });

        g.MapPost("/totp/remove", (PasswordConfirm req, HttpContext ctx, Db db, IOptions<SvnOptions> opt) =>
        {
            var actor = Actor.From(ctx);
            using var conn = db.Open();
            var id = ConfirmPassword(conn, actor.Name, req.Password);
            using var tx = conn.BeginTransaction();
            Mfa.RemoveTotp(conn, tx, id);
            GuardAdminKeepsMfa(conn, tx, actor.Name, id, opt.Value);
            Audit.Write(conn, tx, actor, "mfa.totp.removed", actor.Name);
            tx.Commit();
            return Results.NoContent();
        });

        g.MapPost("/recovery-codes", (PasswordConfirm req, HttpContext ctx, Db db) =>
        {
            var actor = Actor.From(ctx);
            using var conn = db.Open();
            var id = ConfirmPassword(conn, actor.Name, req.Password);
            if (!Mfa.HasMfa(conn, null, id)) throw new AppException("Set up an authenticator app or passkey first.");
            using var tx = conn.BeginTransaction();
            var codes = Mfa.NewRecoveryCodes(conn, tx, id);
            Audit.Write(conn, tx, actor, "mfa.recovery.regenerated", actor.Name);
            tx.Commit();
            return Results.Ok(new { recoveryCodes = codes });
        });

        // ---- passkeys
        g.MapPost("/passkeys/options", (HttpContext ctx, Db db, Passkeys passkeys) =>
        {
            using var conn = db.Open();
            var u = conn.QuerySingle<(long Id, string Username, string FullName)>(
                "SELECT id, username, full_name FROM users WHERE username = @n", new { n = ctx.User.Identity!.Name });
            var (handle, options) = passkeys.RegisterOptions(u.Id, u.Username, u.FullName);
            return Results.Ok(new { handle, options });
        });

        g.MapPost("/passkeys", async (PasskeyRegisterRequest req, HttpContext ctx, Db db, Passkeys passkeys) =>
        {
            var actor = Actor.From(ctx);
            long id;
            bool firstFactor;
            using (var conn = db.Open())
            {
                id = Lookups.UserId(conn, null, actor.Name);
                firstFactor = !Mfa.HasMfa(conn, null, id);
            }
            var pk = await passkeys.RegisterAsync(id, req.Handle, req.Credential, req.Name, ctx.Request.Headers.UserAgent.ToString());
            List<string>? codes = null;
            using (var conn = db.Open())
            {
                using var tx = conn.BeginTransaction();
                if (firstFactor) codes = Mfa.NewRecoveryCodes(conn, tx, id);
                Audit.Write(conn, tx, actor, "mfa.passkey.added", actor.Name, pk.Name);
                tx.Commit();
            }
            await Sessions.SignInAsync(ctx, actor.Name, mfa: true);
            return Results.Ok(new { passkey = pk, recoveryCodes = codes, me = Sessions.BuildMe(ctx) });
        });

        g.MapPut("/passkeys/{id:long}", (long id, RenameRequest req, HttpContext ctx, Db db, Passkeys passkeys) =>
        {
            using var conn = db.Open();
            passkeys.Rename(Lookups.UserId(conn, null, ctx.User.Identity!.Name!), id, req.Name);
            return Results.NoContent();
        });

        g.MapDelete("/passkeys/{id:long}", (long id, HttpContext ctx, Db db, Passkeys passkeys, IOptions<SvnOptions> opt) =>
        {
            var actor = Actor.From(ctx);
            using var conn = db.Open();
            var uid = Lookups.UserId(conn, null, actor.Name);
            var isAdmin = Lookups.IsAdmin(conn, null, actor.Name, opt.Value.AdminGroup);
            if (opt.Value.RequireAdminMfa && isAdmin && !Mfa.HasTotp(conn, null, uid) && Mfa.PasskeyCount(conn, null, uid) <= 1)
                throw new AppException("Admins must keep at least one sign-in method. Add an authenticator app or another passkey first.");
            var name = passkeys.Delete(uid, id);
            Audit.Write(conn, null, actor, "mfa.passkey.removed", actor.Name, name);
            return Results.NoContent();
        });

        // ---- public: forgot password + emailed links
        var pub = app.MapGroup("/api/public").AllowAnonymous().RequireRateLimiting("public");

        pub.MapPost("/forgot", async (ForgotRequest req, HttpContext ctx, Db db, AccountLinks links, EmailSender email) =>
        {
            const string sent = "If that account exists and has an email address, a reset link is on its way. Check your inbox (and spam folder).";
            if (!email.IsConfigured) return Results.Json(new { message = "Password reset by email isn't available. Ask your IT team to reset it." }, statusCode: 400);
            var login = (req.Login ?? "").Trim();
            if (login.Length == 0 || login.Length > 200) return Results.Ok(new { message = sent });

            using var conn = db.Open();
            var user = conn.QuerySingleOrDefault<(long Id, string Username)>("""
                SELECT id, username FROM users
                WHERE is_enabled = 1 AND email <> '' AND (username = @login OR email = @login COLLATE NOCASE)
                """, new { login });
            var actor = new Actor("self-service", ctx.Connection.RemoteIpAddress?.ToString() ?? "");
            if (user.Id == 0)
            {
                Audit.Write(conn, null, actor, "user.reset-link.unknown", login);
            }
            else if (links.RecentResets(user.Id) >= 3)
            {
                Audit.Write(conn, null, actor, "user.reset-link.throttled", user.Username);
            }
            else
            {
                try { await links.SendResetAsync(user.Username, actor); }
                catch (AppException) { /* logged; don't reveal anything to the requester */ }
            }
            return Results.Ok(new { message = sent });
        });

        pub.MapGet("/link", (string token, AccountLinks links) =>
            links.Find(token) is { } t
                ? Results.Ok(new { t.Username, t.FullName, t.Purpose, t.MinPasswordLength })
                : Results.Json(new { message = "This link has expired or was already used. Ask for a new one." }, statusCode: 404));

        pub.MapPost("/link", (SetPasswordRequest req, HttpContext ctx, AccountLinks links, ConfigSync sync, IOptions<SvnOptions> opt) =>
        {
            var t = links.Find(req.Token) ?? throw new AppException("This link has expired or was already used. Ask for a new one.", 404);
            Lookups.ValidatePassword(req.Password, t.Username, opt.Value.MinPasswordLength);
            var actor = new Actor(t.Username, ctx.Connection.RemoteIpAddress?.ToString() ?? "");
            sync.Mutate(actor, (conn, tx) =>
            {
                if (!AccountLinks.Consume(conn, tx, t.TokenId)) throw new AppException("This link was already used.", 404);
                var now = Clock.Now();
                conn.Execute("""
                    UPDATE users SET password_hash = @h, password_changed_at = @now, updated_at = @now, failed_logins = 0, locked_until = NULL
                    WHERE id = @UserId
                    """, new { h = HtpasswdHash.Create(req.Password), now, t.UserId }, tx);
                Audit.Write(conn, tx, actor, t.Purpose == "welcome" ? "user.password.welcome" : "user.password.reset-link", t.Username);
            });
            return Results.Ok(new { message = "Your password is set. Use it for SVN and to sign in here." });
        });
    }

    public sealed record MyAccess(string? Repo, string Path, string Access, string Via, string Url);

    /// <summary>Effective access per repository root and per specific folder rule, for the "My account" page.</summary>
    private static List<MyAccess> AccessFor(System.Data.IDbConnection conn, string username, string publicUrl)
    {
        var groups = Lookups.EffectiveGroups(conn, null, username);
        var rules = conn.Query<AuthzRule>(
            "SELECT repo_name AS Repo, path AS Path, principal_type AS PrincipalType, principal_name AS PrincipalName, access AS Access FROM access_rules");
        return rules
            .Where(r => r.PrincipalType switch
            {
                "user" => r.PrincipalName.Equals(username, StringComparison.OrdinalIgnoreCase),
                "group" => groups.Contains(r.PrincipalName),
                "all" or "authenticated" => true,
                _ => false,
            })
            .Select(r => new MyAccess(r.Repo, r.Path, r.Access, AuthzFile.PrincipalKey(r.PrincipalType, r.PrincipalName),
                r.Repo is null || string.IsNullOrWhiteSpace(publicUrl) ? "" : publicUrl.TrimEnd('/') + "/" + r.Repo + (r.Path == "/" ? "" : r.Path)))
            .OrderBy(r => r.Repo ?? "").ThenBy(r => r.Path)
            .ToList();
    }

    private static long ConfirmPassword(System.Data.IDbConnection conn, string username, string? password)
    {
        var u = conn.QuerySingle<(long Id, string Hash)>("SELECT id, password_hash FROM users WHERE username = @username", new { username });
        if (!HtpasswdHash.Verify(password ?? "", u.Hash)) throw new AppException("Password is incorrect.");
        return u.Id;
    }

    private static void GuardAdminKeepsMfa(System.Data.IDbConnection conn, System.Data.IDbTransaction tx, string username, long id, SvnOptions o)
    {
        if (o.RequireAdminMfa && Lookups.IsAdmin(conn, tx, username, o.AdminGroup) && !Mfa.HasMfa(conn, tx, id))
            throw new AppException("Admins must keep at least one sign-in method. Add a passkey first, then remove the authenticator app.");
    }
}
