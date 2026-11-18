using System.Text.Json;
using Dapper;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Options;
using SvnAdmin.Data;
using SvnAdmin.Security;
using SvnAdmin.Services;

namespace SvnAdmin.Endpoints;

/// <summary>Sign-in for everyone (admins and developers): password, then authenticator/recovery code if enrolled, or a passkey.</summary>
public static class AuthEndpoints
{
    public sealed record LoginRequest(string Username, string Password);
    public sealed record MfaRequest(string Code, string Kind); // kind: totp | recovery
    public sealed record PasskeyLoginRequest(string Handle, JsonElement Credential);

    private const string Generic = "Incorrect username or password.";
    private static readonly string DummyHash = HtpasswdHash.Create(Guid.NewGuid().ToString());

    public static void MapAuth(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/auth");

        g.MapPost("/login", async (LoginRequest req, HttpContext ctx, Db db, ConfigSync sync, IOptions<SvnOptions> opt) =>
        {
            var o = opt.Value;
            sync.ReconcileIfChanged(); // picks up a password just changed outside SvnAdmin
            var username = (req.Username ?? "").Trim();
            var actor = new Actor(username, ctx.Connection.RemoteIpAddress?.ToString() ?? "");

            using var conn = db.Open();
            var user = conn.QuerySingleOrDefault<(long Id, string Username, string PasswordHash, long IsEnabled, string? LockedUntil)>(
                "SELECT id, username, password_hash, is_enabled, locked_until FROM users WHERE username = @username", new { username });

            if (user.Id == 0)
            {
                HtpasswdHash.Verify(req.Password ?? "", DummyHash);
                Audit.Write(conn, null, actor, "auth.login.failed", username, "Unknown user");
                return Results.Json(new { message = Generic }, statusCode: 401);
            }
            if (Sessions.IsLocked(user.LockedUntil))
            {
                Audit.Write(conn, null, actor, "auth.login.locked", username);
                return Results.Json(new { message = $"Too many failed attempts. Try again in {o.LockoutMinutes} minutes." }, statusCode: 429);
            }
            if (!HtpasswdHash.Verify(req.Password ?? "", user.PasswordHash) || user.IsEnabled != 1)
            {
                Sessions.RecordFailure(ctx, user.Id);
                Audit.Write(conn, null, actor, "auth.login.failed", user.Username, user.IsEnabled != 1 ? "Account disabled" : "Wrong password");
                return Results.Json(new { message = Generic }, statusCode: 401);
            }

            actor = actor with { Name = user.Username };
            if (Mfa.HasMfa(conn, null, user.Id))
            {
                await Sessions.SignInPendingAsync(ctx, user.Username);
                Audit.Write(conn, null, actor, "auth.login.password-ok", user.Username, "Waiting for second factor");
                return Results.Ok(new
                {
                    status = "mfa",
                    totp = Mfa.HasTotp(conn, null, user.Id),
                    passkey = Mfa.PasskeyCount(conn, null, user.Id) > 0,
                });
            }

            await Sessions.SignInAsync(ctx, user.Username, mfa: false);
            Audit.Write(conn, null, actor, "auth.login", user.Username);
            return Results.Ok(new { status = "ok", me = Sessions.BuildMe(ctx) });
        }).AllowAnonymous().RequireRateLimiting("login");

        // Second step after a correct password.
        g.MapPost("/mfa", async (MfaRequest req, HttpContext ctx, Db db, Mfa mfa) =>
        {
            var auth = await ctx.AuthenticateAsync(Sessions.PendingScheme);
            var username = auth.Principal?.Identity?.Name;
            if (!auth.Succeeded || username is null)
                return Results.Json(new { message = "Your sign-in timed out. Enter your password again." }, statusCode: 401);

            using var conn = db.Open();
            var user = conn.QuerySingle<(long Id, string? LockedUntil)>("SELECT id, locked_until FROM users WHERE username = @username", new { username });
            var actor = new Actor(username, ctx.Connection.RemoteIpAddress?.ToString() ?? "");
            if (Sessions.IsLocked(user.LockedUntil))
                return Results.Json(new { message = "Too many failed attempts. Try again later." }, statusCode: 429);

            var ok = req.Kind == "recovery"
                ? mfa.UseRecoveryCode(conn, null, user.Id, req.Code ?? "")
                : mfa.VerifyTotp(conn, null, user.Id, req.Code ?? "");
            if (!ok)
            {
                Sessions.RecordFailure(ctx, user.Id);
                Audit.Write(conn, null, actor, "auth.mfa.failed", username, req.Kind == "recovery" ? "Recovery code" : "Authenticator code");
                return Results.Json(new { message = "That code didn't work. Check it and try again." }, statusCode: 401);
            }

            await Sessions.SignInAsync(ctx, username, mfa: true);
            var left = Mfa.RecoveryCodesLeft(conn, null, user.Id);
            Audit.Write(conn, null, actor, "auth.login", username, req.Kind == "recovery" ? $"With a recovery code ({left} left)" : "With authenticator app");
            return Results.Ok(new { status = "ok", me = Sessions.BuildMe(ctx), recoveryCodesLeft = req.Kind == "recovery" ? left : (int?)null });
        }).AllowAnonymous().RequireRateLimiting("login");

        g.MapPost("/passkey/options", (Passkeys passkeys) =>
        {
            var (handle, options) = passkeys.LoginOptions();
            return Results.Ok(new { handle, options });
        }).AllowAnonymous().RequireRateLimiting("login");

        g.MapPost("/passkey", async (PasskeyLoginRequest req, HttpContext ctx, Db db, Passkeys passkeys) =>
        {
            var userId = await passkeys.VerifyLoginAsync(req.Handle, req.Credential);
            using var conn = db.Open();
            var user = conn.QuerySingle<(string Username, long IsEnabled)>("SELECT username, is_enabled FROM users WHERE id = @userId", new { userId });
            var actor = new Actor(user.Username, ctx.Connection.RemoteIpAddress?.ToString() ?? "");
            if (user.IsEnabled != 1)
            {
                Audit.Write(conn, null, actor, "auth.login.failed", user.Username, "Passkey for a disabled account");
                return Results.Json(new { message = "This account is disabled." }, statusCode: 401);
            }
            await Sessions.SignInAsync(ctx, user.Username, mfa: true);
            Audit.Write(conn, null, actor, "auth.login", user.Username, "With a passkey");
            return Results.Ok(new { status = "ok", me = Sessions.BuildMe(ctx) });
        }).AllowAnonymous().RequireRateLimiting("login");

        g.MapPost("/logout", async (HttpContext ctx, Db db) =>
        {
            if (ctx.User.Identity?.IsAuthenticated == true)
                using (var conn = db.Open()) Audit.Write(conn, null, Actor.From(ctx), "auth.logout", ctx.User.Identity.Name!);
            await ctx.SignOutAsync(Sessions.MainScheme);
            await ctx.SignOutAsync(Sessions.PendingScheme);
            return Results.NoContent();
        }).AllowAnonymous();

        g.MapGet("/me", (HttpContext ctx) =>
        {
            Sessions.IssueXsrfCookie(ctx);
            return Sessions.BuildMe(ctx);
        });
    }
}
