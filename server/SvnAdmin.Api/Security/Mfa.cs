using System.Data;
using System.Security.Cryptography;
using System.Text;
using Dapper;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Caching.Memory;
using OtpNet;
using QRCoder;
using SvnAdmin.Data;

namespace SvnAdmin.Security;

/// <summary>
/// Authenticator-app codes (TOTP, RFC 6238: SHA-1, 6 digits, 30 s) and recovery codes.
/// The TOTP secret is encrypted at rest with ASP.NET Data Protection, and each 30-second code
/// can be used only once (the last accepted time step is stored).
/// </summary>
public sealed class Mfa(IDataProtectionProvider dp, IMemoryCache cache, Microsoft.Extensions.Options.IOptions<SvnOptions> options)
{
    private readonly IDataProtector _protector = dp.CreateProtector("SvnAdmin.Totp.v1");
    private string Issuer => string.IsNullOrWhiteSpace(options.Value.ProductName) ? "SVN Admin" : options.Value.ProductName.Trim();

    public sealed record TotpSetup(string Secret, string OtpAuthUri, string QrPngDataUri);

    /// <summary>Creates a new secret, held for 10 minutes until the user proves it works.</summary>
    public TotpSetup BeginTotp(string username)
    {
        var secret = Base32Encoding.ToString(KeyGeneration.GenerateRandomKey(20));
        cache.Set(PendingKey(username), secret, TimeSpan.FromMinutes(10));
        var uri = $"otpauth://totp/{Uri.EscapeDataString(Issuer)}:{Uri.EscapeDataString(username)}" +
                  $"?secret={secret}&issuer={Uri.EscapeDataString(Issuer)}&algorithm=SHA1&digits=6&period=30";
        using var gen = new QRCodeGenerator();
        using var data = gen.CreateQrCode(uri, QRCodeGenerator.ECCLevel.M);
        var png = new PngByteQRCode(data).GetGraphic(6);
        return new TotpSetup(secret, uri, "data:image/png;base64," + Convert.ToBase64String(png));
    }

    /// <summary>Checks the code against the pending secret and, if right, stores it and returns new recovery codes.</summary>
    public List<string>? ConfirmTotp(IDbConnection conn, IDbTransaction tx, long userId, string username, string code)
    {
        if (!cache.TryGetValue(PendingKey(username), out string? secret) || secret is null) return null;
        if (MatchStep(secret, code) is not { } step) return null;
        cache.Remove(PendingKey(username));
        var now = Clock.Now();
        conn.Execute("""
            UPDATE users SET totp_secret = @enc, totp_last_step = @step, mfa_enabled_at = COALESCE(mfa_enabled_at, @now) WHERE id = @userId
            """, new { enc = _protector.Protect(secret), step, now, userId }, tx);
        return NewRecoveryCodes(conn, tx, userId);
    }

    /// <summary>Verifies a sign-in code and records its time step so it can't be replayed.</summary>
    public bool VerifyTotp(IDbConnection conn, IDbTransaction? tx, long userId, string code)
    {
        var row = conn.QuerySingleOrDefault<(string? Secret, long? LastStep)>(
            "SELECT totp_secret, totp_last_step FROM users WHERE id = @userId", new { userId }, tx);
        if (row.Secret is null) return false;
        string secret;
        try { secret = _protector.Unprotect(row.Secret); }
        catch (CryptographicException) { return false; } // keys lost: user must re-enrol
        if (MatchStep(secret, code) is not { } step || step <= (row.LastStep ?? -1)) return false;
        return conn.Execute("UPDATE users SET totp_last_step = @step WHERE id = @userId AND (totp_last_step IS NULL OR totp_last_step < @step)",
            new { step, userId }, tx) == 1;
    }

    public bool UseRecoveryCode(IDbConnection conn, IDbTransaction? tx, long userId, string code)
    {
        var hash = HashCode(code);
        return conn.Execute("UPDATE recovery_codes SET used_at = @now WHERE user_id = @userId AND code_hash = @hash AND used_at IS NULL",
            new { now = Clock.Now(), userId, hash }, tx) == 1;
    }

    /// <summary>Replaces all recovery codes. Returns the plain codes to show once.</summary>
    public static List<string> NewRecoveryCodes(IDbConnection conn, IDbTransaction tx, long userId)
    {
        conn.Execute("DELETE FROM recovery_codes WHERE user_id = @userId", new { userId }, tx);
        var codes = Enumerable.Range(0, 10).Select(_ =>
        {
            var hex = Convert.ToHexString(RandomNumberGenerator.GetBytes(5)).ToLowerInvariant();
            return $"{hex[..5]}-{hex[5..]}";
        }).ToList();
        foreach (var c in codes)
            conn.Execute("INSERT INTO recovery_codes (user_id, code_hash) VALUES (@userId, @h)", new { userId, h = HashCode(c) }, tx);
        return codes;
    }

    public static void RemoveTotp(IDbConnection conn, IDbTransaction tx, long userId)
    {
        conn.Execute("UPDATE users SET totp_secret = NULL, totp_last_step = NULL WHERE id = @userId", new { userId }, tx);
        RefreshEnabledFlag(conn, tx, userId);
    }

    /// <summary>Clears every factor (admin reset when someone loses their phone).</summary>
    public static void ResetAll(IDbConnection conn, IDbTransaction tx, long userId)
    {
        conn.Execute("UPDATE users SET totp_secret = NULL, totp_last_step = NULL, mfa_enabled_at = NULL WHERE id = @userId", new { userId }, tx);
        conn.Execute("DELETE FROM recovery_codes WHERE user_id = @userId; DELETE FROM passkeys WHERE user_id = @userId;", new { userId }, tx);
    }

    /// <summary>MFA counts as on while the user has an authenticator app or at least one passkey.</summary>
    public static void RefreshEnabledFlag(IDbConnection conn, IDbTransaction? tx, long userId)
    {
        var has = HasMfa(conn, tx, userId);
        conn.Execute(has
            ? "UPDATE users SET mfa_enabled_at = COALESCE(mfa_enabled_at, @now) WHERE id = @userId"
            : "UPDATE users SET mfa_enabled_at = NULL WHERE id = @userId", new { now = Clock.Now(), userId }, tx);
        if (!has) conn.Execute("DELETE FROM recovery_codes WHERE user_id = @userId", new { userId }, tx);
    }

    public static bool HasTotp(IDbConnection conn, IDbTransaction? tx, long userId) =>
        conn.ExecuteScalar<long>("SELECT COUNT(*) FROM users WHERE id = @userId AND totp_secret IS NOT NULL", new { userId }, tx) > 0;

    public static int PasskeyCount(IDbConnection conn, IDbTransaction? tx, long userId) =>
        conn.ExecuteScalar<int>("SELECT COUNT(*) FROM passkeys WHERE user_id = @userId", new { userId }, tx);

    public static int RecoveryCodesLeft(IDbConnection conn, IDbTransaction? tx, long userId) =>
        conn.ExecuteScalar<int>("SELECT COUNT(*) FROM recovery_codes WHERE user_id = @userId AND used_at IS NULL", new { userId }, tx);

    public static bool HasMfa(IDbConnection conn, IDbTransaction? tx, long userId) =>
        HasTotp(conn, tx, userId) || PasskeyCount(conn, tx, userId) > 0;

    /// <summary>Returns the matching 30 s time step (current ±1), or null.</summary>
    public static long? MatchStep(string base32Secret, string code)
    {
        code = new string((code ?? "").Where(char.IsDigit).ToArray());
        if (code.Length != 6) return null;
        var totp = new Totp(Base32Encoding.ToBytes(base32Secret), step: 30, mode: OtpHashMode.Sha1, totpSize: 6);
        return totp.VerifyTotp(code, out var step, new VerificationWindow(previous: 1, future: 1)) ? step : null;
    }

    private static string HashCode(string code) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes((code ?? "").Trim().ToLowerInvariant().Replace(" ", ""))));

    private static string PendingKey(string username) => "totp-pending:" + username.ToLowerInvariant();
}
