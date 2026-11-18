using System.Security.Claims;
using Dapper;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.Extensions.Options;
using SvnAdmin.Data;
using SvnAdmin.Services;

namespace SvnAdmin.Security;

/// <summary>
/// Two cookies:
///  - "svnadmin.auth" (main session): claims Name + amr ("pwd" = password only, "mfa" = second factor or passkey).
///    Roles are worked out fresh from the database on every request (see <see cref="Validate"/>).
///  - "svnadmin.mfa" (5 minutes): password was right, waiting for the authenticator / recovery code.
/// </summary>
public static class Sessions
{
    public const string MainScheme = CookieAuthenticationDefaults.AuthenticationScheme;
    public const string PendingScheme = "MfaPending";
    public const string AdminPolicy = "Admin";

    public sealed record Me(
        string Username, string FullName, string Email, bool IsAdmin, bool InAdminGroup, bool NeedsMfaSetup, bool HasMfa,
        string AdminGroup, string PublicUrl, int MinPasswordLength, bool EmailEnabled);

    public static async Task SignInAsync(HttpContext ctx, string username, bool mfa)
    {
        var principal = new ClaimsPrincipal(new ClaimsIdentity(
            [new Claim(ClaimTypes.Name, username), new Claim("amr", mfa ? "mfa" : "pwd")], MainScheme));
        await ctx.SignOutAsync(PendingScheme);
        await ctx.SignInAsync(MainScheme, principal);
        ctx.User = Expand(ctx, principal) ?? principal;
        IssueXsrfCookie(ctx);

        using var conn = ctx.RequestServices.GetRequiredService<Db>().Open();
        conn.Execute("UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = @now WHERE username = @username",
            new { now = Clock.Now(), username });
    }

    public static Task SignInPendingAsync(HttpContext ctx, string username) =>
        ctx.SignInAsync(PendingScheme, new ClaimsPrincipal(new ClaimsIdentity([new Claim(ClaimTypes.Name, username)], PendingScheme)));

    /// <summary>Main-cookie validation: rejects disabled users and adds role claims from the database.</summary>
    public static Task Validate(CookieValidatePrincipalContext ctx)
    {
        var expanded = ctx.Principal is null ? null : Expand(ctx.HttpContext, ctx.Principal);
        if (expanded is null) ctx.RejectPrincipal();
        else ctx.ReplacePrincipal(expanded);
        return Task.CompletedTask;
    }

    private static ClaimsPrincipal? Expand(HttpContext http, ClaimsPrincipal principal)
    {
        var name = principal.Identity?.Name;
        if (name is null) return null;
        var o = http.RequestServices.GetRequiredService<IOptions<SvnOptions>>().Value;
        using var conn = http.RequestServices.GetRequiredService<Db>().Open();
        var user = conn.QuerySingleOrDefault<(long Id, long IsEnabled)>("SELECT id, is_enabled FROM users WHERE username = @name", new { name });
        if (user.Id == 0 || user.IsEnabled != 1) return null;

        var amr = principal.FindFirst("amr")?.Value ?? "pwd";
        var inAdminGroup = Lookups.IsAdmin(conn, null, name, o.AdminGroup);
        var hasMfa = Mfa.HasMfa(conn, null, user.Id);
        var claims = new List<Claim> { new(ClaimTypes.Name, name), new("amr", amr), new(ClaimTypes.Role, "user") };
        if (inAdminGroup && (!o.RequireAdminMfa || amr == "mfa")) claims.Add(new Claim(ClaimTypes.Role, "admin"));
        if (inAdminGroup && o.RequireAdminMfa && !hasMfa) claims.Add(new Claim("mfa_setup", "required"));
        return new ClaimsPrincipal(new ClaimsIdentity(claims, MainScheme));
    }

    public static Me BuildMe(HttpContext ctx)
    {
        var o = ctx.RequestServices.GetRequiredService<IOptions<SvnOptions>>().Value;
        var email = ctx.RequestServices.GetRequiredService<EmailSender>();
        var name = ctx.User.Identity!.Name!;
        using var conn = ctx.RequestServices.GetRequiredService<Db>().Open();
        var u = conn.QuerySingle<(long Id, string FullName, string Email)>("SELECT id, full_name, email FROM users WHERE username = @name", new { name });
        return new Me(name, u.FullName, u.Email,
            ctx.User.IsInRole("admin"),
            Lookups.IsAdmin(conn, null, name, o.AdminGroup),
            ctx.User.HasClaim("mfa_setup", "required"),
            Mfa.HasMfa(conn, null, u.Id),
            o.AdminGroup, o.PublicUrl, o.MinPasswordLength, email.IsConfigured);
    }

    /// <summary>Angular's HttpClient reads XSRF-TOKEN and sends it back as the X-XSRF-TOKEN header.</summary>
    public static void IssueXsrfCookie(HttpContext ctx)
    {
        var tokens = ctx.RequestServices.GetRequiredService<IAntiforgery>().GetAndStoreTokens(ctx);
        ctx.Response.Cookies.Append("XSRF-TOKEN", tokens.RequestToken!, new CookieOptions
        {
            HttpOnly = false,
            Secure = ctx.Request.IsHttps,
            SameSite = SameSiteMode.Strict,
            Path = "/",
        });
    }

    /// <summary>Records a failed attempt and locks the account after too many. Returns true if now locked.</summary>
    public static bool RecordFailure(HttpContext ctx, long userId)
    {
        var o = ctx.RequestServices.GetRequiredService<IOptions<SvnOptions>>().Value;
        using var conn = ctx.RequestServices.GetRequiredService<Db>().Open();
        var failed = conn.ExecuteScalar<long>("SELECT failed_logins FROM users WHERE id = @userId", new { userId }) + 1;
        var lockUntil = failed >= o.MaxFailedLogins ? DateTime.UtcNow.AddMinutes(o.LockoutMinutes).ToString("o") : null;
        conn.Execute("UPDATE users SET failed_logins = @f, locked_until = @lockUntil WHERE id = @userId",
            new { f = lockUntil is null ? failed : 0, lockUntil, userId });
        return lockUntil is not null;
    }

    public static bool IsLocked(string? lockedUntil) =>
        lockedUntil is not null && DateTime.Parse(lockedUntil).ToUniversalTime() > DateTime.UtcNow;
}
