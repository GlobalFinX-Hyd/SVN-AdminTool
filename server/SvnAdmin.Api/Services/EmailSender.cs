using System.Net;
using System.Security.Cryptography;
using MailKit.Net.Smtp;
using MailKit.Security;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Options;
using MimeKit;
using SvnAdmin.Data;

namespace SvnAdmin.Services;

/// <summary>Effective SMTP settings. Saved in the database from the System page; anything not saved falls back to appsettings.</summary>
public sealed record SmtpSettings(bool Enabled, string Host, int Port, string Username, string Password, string FromAddress, string FromName, string BccAddress, string PickupDirectory)
{
    public bool IsComplete =>
        Enabled && !string.IsNullOrWhiteSpace(FromAddress) &&
        (!string.IsNullOrWhiteSpace(PickupDirectory) || !string.IsNullOrWhiteSpace(Host));
}

/// <summary>Sends email through SMTP. Off unless enabled on the System page or in appsettings.</summary>
public sealed class EmailSender(IOptions<EmailOptions> options, Db db, IDataProtectionProvider dp, ILogger<EmailSender> logger)
{
    private readonly EmailOptions _o = options.Value;
    private readonly IDataProtector _protector = dp.CreateProtector("SvnAdmin.Email.v1");

    public bool IsConfigured => Current().IsComplete;

    /// <summary>Database values where saved, otherwise appsettings.</summary>
    public SmtpSettings Current()
    {
        using var conn = db.Open();
        string? S(string key) => ConfigSync.GetSetting(conn, null, "email." + key);
        string? password = null;
        if (S("password") is { Length: > 0 } enc)
        {
            try { password = _protector.Unprotect(enc); }
            catch (CryptographicException ex) { logger.LogError(ex, "Saved SMTP password can't be decrypted (keys changed?). Re-enter it on the System page."); password = ""; }
        }
        return new SmtpSettings(
            S("enabled") is { } e ? e == "true" : _o.Enabled,
            S("host") ?? _o.Host,
            int.TryParse(S("port"), out var p) ? p : _o.Port,
            S("username") ?? _o.Username,
            password ?? _o.Password,
            S("from_address") ?? _o.FromAddress,
            S("from_name") ?? _o.FromName,
            _o.BccAddress,
            _o.PickupDirectory);
    }

    /// <summary>Whether any email setting has been saved from the System page.</summary>
    public bool SavedInDatabase()
    {
        using var conn = db.Open();
        return ConfigSync.GetSetting(conn, null, "email.enabled") is not null;
    }

    /// <param name="password">null keeps the saved password; "" clears it.</param>
    public void Save(bool enabled, string host, int port, string username, string? password, string fromAddress, string fromName)
    {
        using var conn = db.Open();
        using var tx = conn.BeginTransaction();
        void Set(string key, string value) => ConfigSync.SetSetting(conn, tx, "email." + key, value);
        Set("enabled", enabled ? "true" : "false");
        Set("host", host);
        Set("port", port.ToString());
        Set("username", username);
        Set("from_address", fromAddress);
        Set("from_name", fromName);
        if (password is not null) Set("password", password.Length == 0 ? "" : _protector.Protect(password));
        tx.Commit();
    }

    public Task SendAsync(string to, string toName, string subject, string html, string text, CancellationToken ct = default) =>
        SendAsync(Current(), to, toName, subject, html, text, ct);

    /// <summary>Sends with the given settings (used by "Send test email" before the settings are saved).</summary>
    public async Task SendAsync(SmtpSettings s, string to, string toName, string subject, string html, string text, CancellationToken ct = default)
    {
        if (!s.IsComplete) throw new AppException("Email is not set up. Fill in the Email section on the System page.");

        var msg = new MimeMessage();
        msg.From.Add(new MailboxAddress(s.FromName, s.FromAddress));
        msg.To.Add(new MailboxAddress(toName, to));
        if (!string.IsNullOrWhiteSpace(s.BccAddress)) msg.Bcc.Add(MailboxAddress.Parse(s.BccAddress));
        msg.Subject = subject;
        msg.Body = new BodyBuilder { HtmlBody = html, TextBody = text }.ToMessageBody();

        if (!string.IsNullOrWhiteSpace(s.PickupDirectory))
        {
            Directory.CreateDirectory(s.PickupDirectory);
            var file = Path.Combine(s.PickupDirectory, $"{DateTime.UtcNow:yyyyMMdd-HHmmss-fff}-{Guid.NewGuid():N}.eml");
            await msg.WriteToAsync(file, ct);
            logger.LogInformation("Email to {To} written to {File}", to, file);
            return;
        }

        using var smtp = new SmtpClient { Timeout = 20_000 };
        try
        {
            await smtp.ConnectAsync(s.Host, s.Port, s.Port == 465 ? SecureSocketOptions.SslOnConnect : SecureSocketOptions.StartTls, ct);
            if (!string.IsNullOrEmpty(s.Username)) await smtp.AuthenticateAsync(s.Username, s.Password, ct);
            await smtp.SendAsync(msg, ct);
            await smtp.DisconnectAsync(true, ct);
            logger.LogInformation("Email \"{Subject}\" sent to {To}", subject, to);
        }
        catch (Exception ex) when (ex is not AppException and not OperationCanceledException)
        {
            logger.LogError(ex, "Sending email to {To} failed", to);
            throw new AppException("The email could not be sent: " + ex.Message);
        }
    }

    /// <summary>Simple branded layout shared by all emails.</summary>
    public static string Layout(string title, string bodyHtml, string productName = "SVN Admin") => $"""
        <!doctype html><html><body style="margin:0;background:#f3f5f8;font-family:Segoe UI,Arial,sans-serif;color:#1d2733">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:8px;border:1px solid #dde3ea">
        <tr><td style="padding:20px 28px;border-bottom:1px solid #eef1f5;font-size:18px;font-weight:600">{WebUtility.HtmlEncode(title)}</td></tr>
        <tr><td style="padding:24px 28px;font-size:15px;line-height:1.55">{bodyHtml}</td></tr>
        <tr><td style="padding:14px 28px;border-top:1px solid #eef1f5;font-size:12px;color:#6b7785">Sent by {WebUtility.HtmlEncode(productName)}. If you didn't expect this email, you can ignore it or tell your IT team.</td></tr>
        </table></td></tr></table></body></html>
        """;

    public static string Button(string url, string label) =>
        $"""<p style="margin:24px 0"><a href="{WebUtility.HtmlEncode(url)}" style="background:#1f5fae;color:#fff;text-decoration:none;padding:11px 20px;border-radius:6px;display:inline-block;font-weight:600">{WebUtility.HtmlEncode(label)}</a></p>""";
}
