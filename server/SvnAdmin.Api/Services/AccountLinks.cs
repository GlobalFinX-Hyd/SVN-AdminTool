using System.Data;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using Dapper;
using Microsoft.Extensions.Options;
using SvnAdmin.Data;

namespace SvnAdmin.Services;

/// <summary>
/// One-time links emailed to users: "welcome, set your password" and "reset your password".
/// Only a SHA-256 of the token is stored; the token itself exists only in the email.
/// Issuing a new link cancels any earlier unused link of the same kind for that user.
/// </summary>
public sealed class AccountLinks(Db db, EmailSender email, IOptions<SvnOptions> options, ILogger<AccountLinks> logger)
{
    private readonly SvnOptions _o = options.Value;

    public sealed record TokenInfo(long TokenId, long UserId, string Username, string FullName, string Purpose, int MinPasswordLength);

    public async Task SendWelcomeAsync(string username, Actor actor, CancellationToken ct = default)
    {
        var (user, token) = Issue(username, "welcome", TimeSpan.FromHours(_o.WelcomeLinkHours), actor);
        var url = Link("welcome", token);
        var checkout = string.IsNullOrWhiteSpace(_o.PublicUrl) ? "" : _o.PublicUrl.TrimEnd('/') + "/<repository>";
        var name = Greeting(user.FullName, user.Username);
        var html = EmailSender.Layout("Your SVN account is ready", productName: _o.ProductName, bodyHtml: $"""
            <p>Hi {WebUtility.HtmlEncode(name)},</p>
            <p>An SVN account has been created for you. Your username is <strong>{WebUtility.HtmlEncode(user.Username)}</strong>.</p>
            <p>Set your password using the button below. The link works once and expires in {_o.WelcomeLinkHours} hours.</p>
            {EmailSender.Button(url, "Set my password")}
            {(checkout == "" ? "" : $"<p>Then check out with TortoiseSVN from <code>{WebUtility.HtmlEncode(checkout)}</code>. Your team lead will tell you which repositories you can use.</p>")}
            <p style="font-size:13px;color:#6b7785">If the button doesn't work, paste this address into your browser:<br>{WebUtility.HtmlEncode(url)}</p>
            """);
        var text = $"Hi {name},\n\nAn SVN account has been created for you. Username: {user.Username}\n\n" +
                   $"Set your password here (works once, expires in {_o.WelcomeLinkHours} hours):\n{url}\n";
        await email.SendAsync(user.Email, user.FullName, "Your SVN account is ready", html, text, ct);
        Log(actor, "user.welcome.sent", user.Username, $"Sent to {user.Email}");
    }

    public async Task SendResetAsync(string username, Actor actor, CancellationToken ct = default)
    {
        var (user, token) = Issue(username, "reset", TimeSpan.FromMinutes(_o.ResetLinkMinutes), actor);
        var url = Link("reset", token);
        var name = Greeting(user.FullName, user.Username);
        var html = EmailSender.Layout("Reset your SVN password", productName: _o.ProductName, bodyHtml: $"""
            <p>Hi {WebUtility.HtmlEncode(name)},</p>
            <p>Someone asked to reset the SVN password for <strong>{WebUtility.HtmlEncode(user.Username)}</strong>.
               If that was you, choose a new password below. The link works once and expires in {_o.ResetLinkMinutes} minutes.</p>
            {EmailSender.Button(url, "Choose a new password")}
            <p>If you didn't ask for this, ignore this email. Your password won't change.</p>
            <p style="font-size:13px;color:#6b7785">If the button doesn't work, paste this address into your browser:<br>{WebUtility.HtmlEncode(url)}</p>
            """);
        var text = $"Hi {name},\n\nReset the SVN password for {user.Username} here (works once, expires in {_o.ResetLinkMinutes} minutes):\n{url}\n\n" +
                   "If you didn't ask for this, ignore this email.\n";
        await email.SendAsync(user.Email, user.FullName, "Reset your SVN password", html, text, ct);
        Log(actor, "user.reset-link.sent", user.Username, $"Sent to {user.Email}");
    }

    /// <summary>Valid, unused, unexpired token for an enabled user, or null.</summary>
    public TokenInfo? Find(string token)
    {
        if (string.IsNullOrWhiteSpace(token) || token.Length > 100) return null;
        using var conn = db.Open();
        var row = conn.QuerySingleOrDefault<(long Id, long UserId, string Purpose, string ExpiresAt, string? UsedAt, string Username, string FullName, long IsEnabled)>("""
            SELECT t.id, t.user_id, t.purpose, t.expires_at, t.used_at, u.username, u.full_name, u.is_enabled
            FROM user_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = @h
            """, new { h = Hash(token) });
        if (row.Id == 0 || row.UsedAt is not null || row.IsEnabled != 1) return null;
        if (DateTime.Parse(row.ExpiresAt).ToUniversalTime() < DateTime.UtcNow) return null;
        return new TokenInfo(row.Id, row.UserId, row.Username, row.FullName, row.Purpose, _o.MinPasswordLength);
    }

    /// <summary>Marks the token used. Call inside the same transaction that sets the password.</summary>
    public static bool Consume(IDbConnection conn, IDbTransaction tx, long tokenId) =>
        conn.Execute("UPDATE user_tokens SET used_at = @now WHERE id = @tokenId AND used_at IS NULL",
            new { now = Clock.Now(), tokenId }, tx) == 1;

    /// <summary>How many reset emails this user was sent in the last hour (to stop email flooding).</summary>
    public int RecentResets(long userId)
    {
        using var conn = db.Open();
        return conn.ExecuteScalar<int>("SELECT COUNT(*) FROM user_tokens WHERE user_id = @userId AND purpose = 'reset' AND created_at > @since",
            new { userId, since = DateTime.UtcNow.AddHours(-1).ToString("yyyy-MM-ddTHH:mm:ss.fffZ") });
    }

    public bool HasPendingWelcome(IDbConnection conn, long userId) =>
        conn.ExecuteScalar<long>("SELECT COUNT(*) FROM user_tokens WHERE user_id = @userId AND purpose = 'welcome' AND used_at IS NULL AND expires_at > @now",
            new { userId, now = Clock.Now() }) > 0;

    private (UserRow User, string Token) Issue(string username, string purpose, TimeSpan lifetime, Actor actor)
    {
        if (!email.IsConfigured) throw new AppException("Email is not set up, so links can't be sent. See the Email section in DEPLOY.md.");
        if (string.IsNullOrWhiteSpace(_o.AppUrl)) throw new AppException("Svn:AppUrl is not set, so email links can't be built.");

        using var conn = db.Open();
        var user = conn.QuerySingleOrDefault<UserRow>(
            "SELECT id AS Id, username AS Username, full_name AS FullName, email AS Email, is_enabled AS IsEnabled FROM users WHERE username = @username",
            new { username }) ?? throw new NotFoundException($"User '{username}' not found.");
        if (user.IsEnabled != 1) throw new AppException($"{user.Username} is disabled.");
        if (string.IsNullOrWhiteSpace(user.Email)) throw new AppException($"{user.Username} has no email address. Add one first.");

        var token = Base64Url(RandomNumberGenerator.GetBytes(32));
        var now = Clock.Now();
        using var tx = conn.BeginTransaction();
        conn.Execute("UPDATE user_tokens SET used_at = @now WHERE user_id = @Id AND purpose = @purpose AND used_at IS NULL",
            new { now, user.Id, purpose }, tx);
        conn.Execute("""
            INSERT INTO user_tokens (user_id, purpose, token_hash, expires_at, created_at, created_by)
            VALUES (@Id, @purpose, @hash, @exp, @now, @by)
            """, new { user.Id, purpose, hash = Hash(token), exp = DateTime.UtcNow.Add(lifetime).ToString("yyyy-MM-ddTHH:mm:ss.fffZ"), now, by = actor.Name }, tx);
        tx.Commit();
        return (user, token);
    }

    private void Log(Actor actor, string action, string target, string details)
    {
        using var conn = db.Open();
        Audit.Write(conn, null, actor, action, target, details);
        logger.LogInformation("{Action} for {Target}", action, target);
    }

    private string Link(string purpose, string token) =>
        $"{_o.AppUrl.TrimEnd('/')}/account/set-password?kind={purpose}&token={token}";

    private static string Greeting(string fullName, string username) =>
        string.IsNullOrWhiteSpace(fullName) ? username : fullName.Split(' ', StringSplitOptions.RemoveEmptyEntries)[0];

    public static string Hash(string token) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)));

    public static string Base64Url(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private sealed record UserRow(long Id, string Username, string FullName, string Email, long IsEnabled);
}
