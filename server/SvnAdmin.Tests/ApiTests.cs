using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using OtpNet;

namespace SvnAdmin.Tests;

/// <summary>Starts the real app against a throw-away folder of SVN config files.</summary>
public sealed class ApiFactory : WebApplicationFactory<Program>
{
    public string Dir { get; } = Path.Combine(Path.GetTempPath(), "svnadmin-tests-" + Guid.NewGuid().ToString("N"));
    public string Passwd => Path.Combine(Dir, "svn_users.passwd");
    public string Authz => Path.Combine(Dir, "svn_access_control.authz");

    // openssl passwd -apr1 -salt Xy12AbCd 'DevAdmin#2026'
    public const string AdminPassword = "DevAdmin#2026";

    public ApiFactory()
    {
        Directory.CreateDirectory(Path.Combine(Dir, "Repositories"));
        File.WriteAllText(Passwd, "admin:$apr1$Xy12AbCd$NQ42w/7WcJh.Ls8oxYSfQ1\ndev:$apr1$Xy12AbCd$NQ42w/7WcJh.Ls8oxYSfQ1\nresetme:$apr1$Xy12AbCd$NQ42w/7WcJh.Ls8oxYSfQ1\n");
        File.WriteAllText(Authz, "[groups]\nitadmins = admin\ndevs = dev\n\n[/]\n@itadmins = rw\n");
    }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Testing");
        foreach (var (k, v) in new Dictionary<string, string>
        {
            ["Svn:DatabasePath"] = Path.Combine(Dir, "svnadmin.db"),
            ["Svn:PasswdFile"] = Passwd,
            ["Svn:AuthzFile"] = Authz,
            ["Svn:RepositoriesRoot"] = Path.Combine(Dir, "Repositories"),
            ["Svn:ArchiveRoot"] = Path.Combine(Dir, "Archive"),
            ["Svn:BackupRoot"] = Path.Combine(Dir, "Backups"),
            ["Svn:ConfigHistoryDir"] = Path.Combine(Dir, "history"),
            ["Svn:KeysDir"] = Path.Combine(Dir, "keys"),
            ["Svn:AppUrl"] = "http://localhost",
            ["Svn:RequireAdminMfa"] = "true",
            ["Svn:LoginAttemptsPerMinute"] = "1000", // every test signs in from the same address
            ["Email:Enabled"] = "true",
            ["Email:FromAddress"] = "svnadmin@example.test",
            ["Email:PickupDirectory"] = Path.Combine(Dir, "mail"),
        })
            builder.UseSetting(k, v);
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        try { Directory.Delete(Dir, true); } catch (IOException) { /* SQLite may still hold the file briefly */ }
    }
}

public class ApiTests : IClassFixture<ApiFactory>
{
    private readonly ApiFactory _f;
    public ApiTests(ApiFactory f) => _f = f;

    private HttpClient NewClient() => _f.CreateClient(new WebApplicationFactoryClientOptions { HandleCookies = true, AllowAutoRedirect = false });

    /// <summary>Sends the XSRF-TOKEN cookie back as the header, like Angular does.</summary>
    private static async Task<HttpResponseMessage> Send(HttpClient c, HttpMethod m, string url, object? body = null)
    {
        var req = new HttpRequestMessage(m, url);
        if (body is not null) req.Content = JsonContent.Create(body);
        var me = await c.GetAsync("/api/auth/me"); // refreshes the XSRF cookie when signed in
        if (me.Headers.TryGetValues("Set-Cookie", out var cookies))
        {
            var xsrf = cookies.FirstOrDefault(x => x.StartsWith("XSRF-TOKEN="));
            if (xsrf is not null) req.Headers.Add("X-XSRF-TOKEN", Uri.UnescapeDataString(xsrf.Split(';')[0]["XSRF-TOKEN=".Length..]));
        }
        return await c.SendAsync(req);
    }

    private static async Task<JsonElement> Json(HttpResponseMessage r) => JsonDocument.Parse(await r.Content.ReadAsStringAsync()).RootElement;

    /// <summary>Signs in as admin, enrolling the authenticator app on first use. Returns the TOTP secret.</summary>
    private async Task<(HttpClient Client, string Secret)> AdminWithMfa()
    {
        var c = NewClient();
        var login = await Json(await c.PostAsJsonAsync("/api/auth/login", new { username = "admin", password = ApiFactory.AdminPassword }));
        if (login.GetProperty("status").GetString() == "mfa")
        {
            // Each TOTP code works once (replay protection), so later sign-ins use a fresh recovery code each.
            var ok = await c.PostAsJsonAsync("/api/auth/mfa", new { code = _recovery.Dequeue(), kind = "recovery" });
            Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
            return (c, _secret!);
        }
        var setup = await Json(await Send(c, HttpMethod.Post, "/api/account/totp/setup"));
        _secret = setup.GetProperty("secret").GetString()!;
        var confirm = await Send(c, HttpMethod.Post, "/api/account/totp/confirm", new { code = new Totp(Base32Encoding.ToBytes(_secret)).ComputeTotp() });
        Assert.Equal(HttpStatusCode.OK, confirm.StatusCode);
        foreach (var rc in (await Json(confirm)).GetProperty("recoveryCodes").EnumerateArray()) _recovery.Enqueue(rc.GetString()!);
        return (c, _secret);
    }
    private static string? _secret;
    private static readonly Queue<string> _recovery = new();

    [Fact]
    public async Task Anonymous_requests_to_admin_api_are_refused()
    {
        var r = await NewClient().GetAsync("/api/users");
        Assert.Equal(HttpStatusCode.Unauthorized, r.StatusCode);
    }

    [Fact]
    public async Task Wrong_password_is_refused_with_a_generic_message()
    {
        var r = await NewClient().PostAsJsonAsync("/api/auth/login", new { username = "admin", password = "nope" });
        Assert.Equal(HttpStatusCode.Unauthorized, r.StatusCode);
        Assert.Equal("Incorrect username or password.", (await Json(r)).GetProperty("message").GetString());
    }

    [Fact]
    public async Task Developer_can_use_my_account_but_not_admin_pages()
    {
        var c = NewClient();
        var login = await Json(await c.PostAsJsonAsync("/api/auth/login", new { username = "dev", password = ApiFactory.AdminPassword }));
        Assert.False(login.GetProperty("me").GetProperty("isAdmin").GetBoolean());
        Assert.Equal(HttpStatusCode.OK, (await c.GetAsync("/api/account")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await c.GetAsync("/api/users")).StatusCode);
    }

    [Fact]
    public async Task Admin_needs_mfa_before_admin_pages_then_gets_in()
    {
        var c = NewClient();
        var first = await Json(await c.PostAsJsonAsync("/api/auth/login", new { username = "admin", password = ApiFactory.AdminPassword }));
        if (first.GetProperty("status").GetString() == "ok")
        {
            Assert.True(first.GetProperty("me").GetProperty("needsMfaSetup").GetBoolean());
            Assert.Equal(HttpStatusCode.Forbidden, (await c.GetAsync("/api/users")).StatusCode);
        }
        var (admin, _) = await AdminWithMfa();
        Assert.Equal(HttpStatusCode.OK, (await admin.GetAsync("/api/users")).StatusCode);
    }

    [Fact]
    public async Task State_changes_without_the_csrf_header_are_refused()
    {
        var (c, _) = await AdminWithMfa();
        var r = await c.PostAsJsonAsync("/api/groups", new { name = "nocsrf", users = Array.Empty<string>(), groups = Array.Empty<string>() });
        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
    }

    [Fact]
    public async Task Creating_a_group_rewrites_authz_and_hand_edits_block_further_changes()
    {
        var (c, _) = await AdminWithMfa();
        var created = await Send(c, HttpMethod.Post, "/api/groups", new { name = "qa", description = "", users = new[] { "dev" }, groups = Array.Empty<string>() });
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        Assert.Contains("qa = dev", await File.ReadAllTextAsync(_f.Authz));

        await File.AppendAllTextAsync(_f.Authz, "# hand edit\n");
        var blocked = await Send(c, HttpMethod.Post, "/api/groups", new { name = "qa2", description = "", users = Array.Empty<string>(), groups = Array.Empty<string>() });
        Assert.Equal(HttpStatusCode.Conflict, blocked.StatusCode);

        Assert.Equal(HttpStatusCode.OK, (await Send(c, HttpMethod.Post, "/api/system/authz/reimport")).StatusCode);
        Assert.Equal(HttpStatusCode.Created,
            (await Send(c, HttpMethod.Post, "/api/groups", new { name = "qa2", description = "", users = Array.Empty<string>(), groups = Array.Empty<string>() })).StatusCode);
    }

    [Fact]
    public async Task A_group_cycle_is_refused_and_the_authz_file_is_untouched()
    {
        var (c, _) = await AdminWithMfa();
        await Send(c, HttpMethod.Post, "/api/groups", new { name = "ca", description = "", users = Array.Empty<string>(), groups = Array.Empty<string>() });
        await Send(c, HttpMethod.Post, "/api/groups", new { name = "cb", description = "", users = Array.Empty<string>(), groups = new[] { "ca" } });
        var before = await File.ReadAllTextAsync(_f.Authz);
        var r = await Send(c, HttpMethod.Put, "/api/groups/ca", new { name = "ca", description = "", users = Array.Empty<string>(), groups = new[] { "cb" } });
        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        Assert.Equal(before, await File.ReadAllTextAsync(_f.Authz));
    }

[Fact]
    public async Task Password_reset_link_works_once()
    {
        var (c, _) = await AdminWithMfa();
        await Send(c, HttpMethod.Put, "/api/users/resetme", new { fullName = "Reset Me", email = "resetme@example.test", notes = "", isEnabled = true, groups = Array.Empty<string>() });
        var anon = NewClient();
        Assert.Equal(HttpStatusCode.OK, (await anon.PostAsJsonAsync("/api/public/forgot", new { login = "resetme@example.test" })).StatusCode);

        var mail = Directory.GetFiles(Path.Combine(_f.Dir, "mail")).OrderBy(File.GetCreationTimeUtc).Last();
        var token = System.Text.RegularExpressions.Regex.Match(await File.ReadAllTextAsync(mail), "token=([A-Za-z0-9_-]+)").Groups[1].Value;
        Assert.NotEmpty(token);

        Assert.Equal(HttpStatusCode.OK, (await anon.PostAsJsonAsync("/api/public/link", new { token, password = "Brand#New2026" })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await anon.PostAsJsonAsync("/api/public/link", new { token, password = "Again#New2026" })).StatusCode);
        Assert.Matches("(?m)^resetme:\\$2y\\$", await File.ReadAllTextAsync(_f.Passwd));
        var login = await Json(await NewClient().PostAsJsonAsync("/api/auth/login", new { username = "resetme", password = "Brand#New2026" }));
        Assert.Equal("ok", login.GetProperty("status").GetString());
    }

    [Fact]
    public async Task Config_backup_snapshots_passwd_authz_and_database_and_downloads_as_zip()
    {
        var (c, _) = await AdminWithMfa();
        var run = await Send(c, HttpMethod.Post, "/api/backups/run");
        Assert.Equal(HttpStatusCode.OK, run.StatusCode);
        var snap = await Json(run);
        var files = snap.GetProperty("files").EnumerateArray().Select(f => f.GetProperty("name").GetString()).ToList();
        Assert.Equal(["svn_access_control.authz", "svn_users.passwd", "svnadmin.db"], files);
        Assert.Matches(@"^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(-\d+)?$", snap.GetProperty("id").GetString()); // named by date and time

        var zip = await c.GetAsync($"/api/backups/{snap.GetProperty("id").GetString()}/download");
        Assert.Equal(HttpStatusCode.OK, zip.StatusCode);
        Assert.Equal("application/zip", zip.Content.Headers.ContentType?.MediaType);
        using var archive = new System.IO.Compression.ZipArchive(await zip.Content.ReadAsStreamAsync());
        Assert.Equal(3, archive.Entries.Count);

        Assert.Equal(HttpStatusCode.BadRequest, (await c.GetAsync("/api/backups/..%5C..%5Cdata/download")).StatusCode);
    }

    [Fact]
    public async Task Restoring_a_snapshot_puts_back_groups_and_accounts_and_keeps_a_safety_copy()
    {
        var (c, _) = await AdminWithMfa();
        var snap = await Json(await Send(c, HttpMethod.Post, "/api/backups/run"));
        var id = snap.GetProperty("id").GetString()!;

        // Changes made after the snapshot: a new group, a new user, and dev disabled.
        Assert.Equal(HttpStatusCode.Created, (await Send(c, HttpMethod.Post, "/api/groups",
            new { name = "after-snapshot", description = "", users = Array.Empty<string>(), groups = Array.Empty<string>() })).StatusCode);
        Assert.Equal(HttpStatusCode.Created, (await Send(c, HttpMethod.Post, "/api/users",
            new { username = "newbie", password = "Fresh#Pass2026x", groups = Array.Empty<string>(), sendWelcome = false })).StatusCode);
        await Send(c, HttpMethod.Put, "/api/users/dev", new { fullName = "", email = "", notes = "", isEnabled = false, groups = new[] { "devs" } });

        var restore = await Send(c, HttpMethod.Post, $"/api/backups/{id}/restore");
        Assert.Equal(HttpStatusCode.OK, restore.StatusCode);
        Assert.NotEqual(id, (await Json(restore)).GetProperty("safetySnapshot").GetString());

        var authz = await File.ReadAllTextAsync(_f.Authz);
        var passwd = await File.ReadAllTextAsync(_f.Passwd);
        Assert.DoesNotContain("after-snapshot", authz);
        Assert.Matches("(?m)^dev:", passwd);        // re-enabled
        Assert.DoesNotMatch("(?m)^newbie:", passwd); // not in the snapshot, so disabled

        var users = await Json(await c.GetAsync("/api/users"));
        Assert.False(users.EnumerateArray().Single(u => u.GetProperty("username").GetString() == "newbie").GetProperty("isEnabled").GetBoolean());
    }

    [Fact]
    public async Task Snapshots_can_be_deleted_but_never_the_last_one()
    {
        var (c, _) = await AdminWithMfa();
        var a = (await Json(await Send(c, HttpMethod.Post, "/api/backups/run"))).GetProperty("id").GetString()!;
        var b = (await Json(await Send(c, HttpMethod.Post, "/api/backups/run"))).GetProperty("id").GetString()!;
        Assert.NotEqual(a, b);

        Assert.Equal(HttpStatusCode.NoContent, (await Send(c, HttpMethod.Delete, $"/api/backups/{a}")).StatusCode);
        Assert.False(Directory.Exists(Path.Combine(_f.Dir, "Backups", "config", a)));
        Assert.Equal(HttpStatusCode.NotFound, (await Send(c, HttpMethod.Delete, $"/api/backups/{a}")).StatusCode);

        // Delete every other snapshot until one is left; that one must be refused.
        var all = (await Json(await c.GetAsync("/api/backups"))).GetProperty("snapshots").EnumerateArray().Select(s => s.GetProperty("id").GetString()!).ToList();
        foreach (var id in all.Skip(1)) await Send(c, HttpMethod.Delete, $"/api/backups/{id}");
        var last = await Send(c, HttpMethod.Delete, $"/api/backups/{all[0]}");
        Assert.Equal(HttpStatusCode.BadRequest, last.StatusCode);
        Assert.True(Directory.Exists(Path.Combine(_f.Dir, "Backups", "config", all[0])));
    }

    [Fact]
    public async Task Audit_log_downloads_as_csv_with_filters_and_date_range()
    {
        var (c, _) = await AdminWithMfa();
        await Send(c, HttpMethod.Post, "/api/groups", new { name = "audited", description = "", users = Array.Empty<string>(), groups = Array.Empty<string>() });

        var all = await c.GetAsync("/api/audit/export");
        Assert.Equal(HttpStatusCode.OK, all.StatusCode);
        Assert.Equal("text/csv", all.Content.Headers.ContentType?.MediaType);
        Assert.Contains("svnadmin-audit-all-", all.Content.Headers.ContentDisposition?.FileNameStar ?? all.Content.Headers.ContentDisposition?.FileName);
        var allText = await all.Content.ReadAsStringAsync();
        Assert.StartsWith("﻿When (server time),When (UTC),Who,What,Target,Details,IP address", allText);
        Assert.Contains("group.create", allText);

        var groupsOnly = await (await c.GetAsync("/api/audit/export?action=group.")).Content.ReadAsStringAsync();
        Assert.Contains("\"audited\"", groupsOnly);
        Assert.DoesNotContain("auth.login", groupsOnly);

        var future = DateTimeOffset.UtcNow.AddDays(1).ToString("o");
        var none = await (await c.GetAsync($"/api/audit/export?from={Uri.EscapeDataString(future)}")).Content.ReadAsStringAsync();
        Assert.Single(none.Split("\r\n", StringSplitOptions.RemoveEmptyEntries)); // header only
    }

    [Fact]
    public async Task Email_settings_save_from_the_ui_never_return_the_password_and_send_a_test()
    {
        var (c, _) = await AdminWithMfa();
        var body = new { enabled = true, host = "smtp.example.test", port = 587, username = "postmaster@mg.example.test",
            password = "Smtp-Secret-123", fromAddress = "svn@example.test", fromName = "Example SVN", testTo = (string?)null };
        Assert.Equal(HttpStatusCode.NoContent, (await Send(c, HttpMethod.Put, "/api/system/email", body)).StatusCode);

        var raw = await (await c.GetAsync("/api/system/email")).Content.ReadAsStringAsync();
        Assert.DoesNotContain("Smtp-Secret-123", raw);
        var s = JsonDocument.Parse(raw).RootElement;
        Assert.True(s.GetProperty("passwordSet").GetBoolean());
        Assert.True(s.GetProperty("savedInApp").GetBoolean());
        Assert.Equal("svn@example.test", s.GetProperty("fromAddress").GetString());

        // Saving again without a password keeps the saved one.
        Assert.Equal(HttpStatusCode.NoContent, (await Send(c, HttpMethod.Put, "/api/system/email", body with { password = (string?)null })).StatusCode);
        Assert.True((await Json(await c.GetAsync("/api/system/email"))).GetProperty("passwordSet").GetBoolean());

        // The test uses the form's values; the test factory routes mail to a folder.
        var before = Directory.Exists(Path.Combine(_f.Dir, "mail")) ? Directory.GetFiles(Path.Combine(_f.Dir, "mail")).Length : 0;
        var test = await Send(c, HttpMethod.Post, "/api/system/email/test", body with { password = (string?)null, testTo = "someone@example.test" });
        Assert.Equal(HttpStatusCode.OK, test.StatusCode);
        Assert.Equal(before + 1, Directory.GetFiles(Path.Combine(_f.Dir, "mail")).Length);

        var bad = await Send(c, HttpMethod.Put, "/api/system/email", body with { fromAddress = "not-an-address" });
        Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
    }

    [Fact]
    public async Task Forgot_password_never_reveals_whether_an_account_exists()
    {
        var a = await NewClient().PostAsJsonAsync("/api/public/forgot", new { login = "nobody@example.test" });
        Assert.Equal(HttpStatusCode.OK, a.StatusCode);
        Assert.Contains("If that account exists", (await Json(a)).GetProperty("message").GetString());
    }
}
