using System.Net;
using System.Text;
using Dapper;
using Microsoft.Extensions.Options;
using SvnAdmin.Data;
using SvnAdmin.Services;
using SvnAdmin.Svn;

namespace SvnAdmin.Endpoints;

/// <summary>Backups, audit log, system status and the dashboard.</summary>
public static class AdminEndpoints
{
    public sealed record AuditEntry(long Id, string At, string Actor, string Action, string Target, string Details, string Ip);
    public sealed record BackupRun(long Id, string RepoName, string Kind, string Trigger, string StartedAt, string? FinishedAt,
        string Status, long? Revision, string TargetPath, string Message);
    /// <param name="Password">null = keep the saved password, "" = clear it.</param>
    public sealed record EmailSettingsRequest(bool Enabled, string? Host, int Port, string? Username, string? Password,
        string? FromAddress, string? FromName, string? TestTo);

    private static bool LooksLikeEmail(string s) =>
        System.Text.RegularExpressions.Regex.IsMatch(s, @"^[^@\s]+@[^@\s]+\.[^@\s]+$");

    private static SmtpSettings ValidateEmail(EmailSettingsRequest r, EmailSender email)
    {
        var host = (r.Host ?? "").Trim();
        var from = (r.FromAddress ?? "").Trim();
        if (r.Enabled || r.TestTo is not null)
        {
            if (host.Length == 0) throw new AppException("Enter the SMTP server, e.g. smtp.example.com.");
            if (!LooksLikeEmail(from)) throw new AppException("Enter a valid From address (one your SMTP provider allows you to send from).");
        }
        if (r.Port is < 1 or > 65535) throw new AppException("Port must be between 1 and 65535 (usually 587).");
        if (host.Contains(' ') || host.Contains('/')) throw new AppException("Enter just the server name, e.g. smtp.example.com.");
        var current = email.Current();
        return current with
        {
            Enabled = r.Enabled, Host = host, Port = r.Port, Username = (r.Username ?? "").Trim(),
            Password = r.Password is { Length: > 0 } ? r.Password : r.Password is null ? current.Password : "",
            FromAddress = from, FromName = string.IsNullOrWhiteSpace(r.FromName) ? "SVN Admin" : r.FromName.Trim(),
        };
    }

    public static void MapAdmin(this IEndpointRouteBuilder app)
    {
        // ---------------------------------------------------------------- config backups
        var b = app.MapGroup("/api/backups");

        b.MapGet("/", (int? limit, Db db, BackupService backups) =>
        {
            using var conn = db.Open();
            var runs = conn.Query<BackupRun>("SELECT * FROM backup_runs WHERE kind = 'config' ORDER BY started_at DESC LIMIT @n",
                new { n = Math.Clamp(limit ?? 100, 1, 1000) }).ToList();
            return new { running = backups.IsRunning, snapshots = backups.List(), runs };
        });

        b.MapDelete("/{id}", (string id, HttpContext ctx, BackupService backups) =>
        {
            backups.Delete(id, Actor.From(ctx));
            return Results.NoContent();
        });

        b.MapPost("/{id}/restore", (string id, HttpContext ctx, BackupService backups) => backups.Restore(id, Actor.From(ctx)));

        b.MapGet("/{id}/download", (string id, HttpContext ctx, Db db, BackupService backups) =>
        {
            var (zip, name) = backups.Zip(id);
            using (var conn = db.Open()) Audit.Write(conn, null, Actor.From(ctx), "backup.download", id);
            return Results.File(zip, "application/zip", name);
        });

        b.MapGet("/settings", (BackupService backups) => backups.GetSettings());

        b.MapPut("/settings", (BackupSettings s, HttpContext ctx, BackupService backups) =>
        {
            backups.SaveSettings(s, Actor.From(ctx));
            return Results.NoContent();
        });

        b.MapPost("/run", (HttpContext ctx, BackupService backups) =>
            backups.TryRun("manual", Actor.From(ctx)) is { } snapshot
                ? Results.Ok(snapshot)
                : Results.Json(new { message = "A config backup is already being taken." }, statusCode: 409));

        // ---------------------------------------------------------------- audit
        app.MapGet("/api/audit", (string? search, string? action, DateTimeOffset? from, DateTimeOffset? to, int? page, int? pageSize, Db db) =>
        {
            var size = Math.Clamp(pageSize ?? 50, 10, 500);
            var p = Math.Max(1, page ?? 1);
            var (where, args) = AuditFilter(search, action, from, to);
            using var conn = db.Open();
            var total = conn.ExecuteScalar<long>($"SELECT COUNT(*) FROM audit_log {where}", args);
            args.Add("limit", size);
            args.Add("offset", (p - 1) * size);
            var items = conn.Query<AuditEntry>($"SELECT * FROM audit_log {where} ORDER BY id DESC LIMIT @limit OFFSET @offset", args).ToList();
            return new { total, page = p, pageSize = size, items };
        });

        // Download as CSV (opens in Excel). Same filters as the page; no filters = the whole log.
        app.MapGet("/api/audit/export", (string? search, string? action, DateTimeOffset? from, DateTimeOffset? to, HttpContext ctx, Db db) =>
        {
            var (where, args) = AuditFilter(search, action, from, to);
            using var conn = db.Open();
            var rows = conn.Query<AuditEntry>($"SELECT * FROM audit_log {where} ORDER BY id DESC", args).ToList();
            var sb = new StringBuilder("When (server time),When (UTC),Who,What,Target,Details,IP address\r\n");
            foreach (var e in rows)
            {
                var local = DateTime.TryParse(e.At, null, System.Globalization.DateTimeStyles.RoundtripKind, out var at)
                    ? at.ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss") : e.At;
                sb.AppendJoin(',', new[] { local, e.At, e.Actor, e.Action, e.Target, e.Details, e.Ip }.Select(Csv)).Append("\r\n");
            }
            var filtered = where != "";
            Audit.Write(conn, null, Actor.From(ctx), "audit.download", filtered ? "filtered" : "everything", $"{rows.Count} entries");
            var range = (from, to) switch
            {
                ({ } f, { } t) => $"{f.LocalDateTime:yyyy-MM-dd}_to_{t.LocalDateTime.AddSeconds(-1):yyyy-MM-dd}",
                ({ } f, null) => $"from-{f.LocalDateTime:yyyy-MM-dd}",
                (null, { } t) => $"to-{t.LocalDateTime.AddSeconds(-1):yyyy-MM-dd}",
                _ => filtered ? "filtered" : "all",
            };
            return Results.File(Encoding.UTF8.GetPreamble().Concat(Encoding.UTF8.GetBytes(sb.ToString())).ToArray(),
                "text/csv", $"svnadmin-audit-{range}-{DateTime.Now:yyyy-MM-dd_HH-mm}.csv");
        });

        // ---------------------------------------------------------------- system
        app.MapGet("/api/system/status", (ConfigSync sync, SvnCli svn, Db db, IOptions<SvnOptions> opt) =>
        {
            var o = opt.Value;
            return new
            {
                files = sync.Status(),
                tools = new[] { "svn", "svnadmin", "svnlook" }.ToDictionary(t => t, svn.ToolExists),
                paths = new
                {
                    database = db.FilePath,
                    o.RepositoriesRoot,
                    repositoriesRootExists = Directory.Exists(o.RepositoriesRoot),
                    o.ArchiveRoot,
                    o.BackupRoot,
                    o.ConfigHistoryDir,
                    o.SvnBinDir,
                },
                o.AdminGroup,
                o.PublicUrl,
                o.MinPasswordLength,
                o.PasswordMaxAgeDays,
                version = typeof(AdminEndpoints).Assembly.GetName().Version?.ToString(),
            };
        });

        app.MapGet("/api/system/email", (EmailSender email, IOptions<SvnOptions> so) =>
        {
            var s = email.Current();
            return new
            {
                configured = s.IsComplete,
                s.Enabled, s.Host, s.Port, s.Username, passwordSet = s.Password.Length > 0, s.FromAddress, s.FromName,
                savedInApp = email.SavedInDatabase(),
                usesPickupFolder = !string.IsNullOrWhiteSpace(s.PickupDirectory),
                appUrl = so.Value.AppUrl,
                passkeyRpId = string.IsNullOrWhiteSpace(so.Value.Passkeys.RelyingPartyId) && Uri.TryCreate(so.Value.AppUrl, UriKind.Absolute, out var u) ? u.Host : so.Value.Passkeys.RelyingPartyId,
                so.Value.RequireAdminMfa,
            };
        });

        app.MapPut("/api/system/email", (EmailSettingsRequest req, HttpContext ctx, Db db, EmailSender email) =>
        {
            var s = ValidateEmail(req, email);
            email.Save(s.Enabled, s.Host, s.Port, s.Username, req.Password, s.FromAddress, s.FromName);
            using var conn = db.Open();
            Audit.Write(conn, null, Actor.From(ctx), "email.settings", s.Host,
                $"Enabled: {s.Enabled}, {s.Host}:{s.Port}, user: {s.Username}, from: {s.FromName} <{s.FromAddress}>" +
                (req.Password is null ? "" : req.Password.Length == 0 ? ", password cleared" : ", password changed"));
            return Results.NoContent();
        });

        // Sends a test with the values in the form (not yet saved); an empty password field means "use the saved one".
        app.MapPost("/api/system/email/test", async (EmailSettingsRequest req, HttpContext ctx, Db db, EmailSender email, IOptions<SvnOptions> opt) =>
        {
            var product = opt.Value.ProductName;
            var s = ValidateEmail(req, email) with { Enabled = true };
            var to = (req.TestTo ?? "").Trim();
            using var conn = db.Open();
            if (to.Length == 0)
                to = conn.ExecuteScalar<string>("SELECT email FROM users WHERE username = @n", new { n = ctx.User.Identity!.Name }) ?? "";
            if (!LooksLikeEmail(to)) throw new AppException("Enter an address to send the test email to.");
            await email.SendAsync(s, to, "", $"{product} test email",
                EmailSender.Layout("Test email", productName: product, bodyHtml: $"<p>Email from {WebUtility.HtmlEncode(product)} is working.</p><p style=\"font-size:13px;color:#6b7785\">Sent through {WebUtility.HtmlEncode(s.Host)}:{s.Port} as {WebUtility.HtmlEncode(s.FromAddress)}.</p>"),
                $"Email from {product} is working.");
            Audit.Write(conn, null, Actor.From(ctx), "email.test", to, $"{s.Host}:{s.Port}");
            return Results.Ok(new { sentTo = to });
        });

        app.MapGet("/api/system/authz-preview", (ConfigSync sync) => Results.Text(sync.PreviewAuthz(), "text/plain"));

        app.MapGet("/api/system/authz-current", (IOptions<SvnOptions> opt) =>
            File.Exists(opt.Value.AuthzFile)
                ? Results.Text(File.ReadAllText(opt.Value.AuthzFile), "text/plain")
                : Results.NotFound(new { message = "Authz file not found." }));

        app.MapPost("/api/system/authz/reimport", (HttpContext ctx, ConfigSync sync) =>
            new { warnings = sync.ReimportAuthz(Actor.From(ctx)) });

        app.MapPost("/api/system/authz/overwrite", (HttpContext ctx, ConfigSync sync) =>
        {
            sync.Mutate(Actor.From(ctx), (_, _) => { }, overwriteAuthz: true);
            return Results.NoContent();
        });

        // ---------------------------------------------------------------- dashboard
        app.MapGet("/api/dashboard", async (Db db, ConfigSync sync, RepoService repos, BackupService backups, IOptions<SvnOptions> opt, CancellationToken ct) =>
        {
            sync.ReconcileIfChanged();
            var o = opt.Value;
            var repoList = await repos.ListAsync(includeDetails: true, ct);
            using var conn = db.Open();
            var staleCutoff = DateTime.UtcNow.AddDays(-Math.Max(o.PasswordMaxAgeDays, 1)).ToString("yyyy-MM-ddTHH:mm:ss.fffZ");
            return new
            {
                users = new
                {
                    total = conn.ExecuteScalar<long>("SELECT COUNT(*) FROM users"),
                    enabled = conn.ExecuteScalar<long>("SELECT COUNT(*) FROM users WHERE is_enabled = 1"),
                    stalePasswords = o.PasswordMaxAgeDays <= 0 ? 0 : conn.ExecuteScalar<long>(
                        "SELECT COUNT(*) FROM users WHERE is_enabled = 1 AND (password_changed_at IS NULL OR password_changed_at < @staleCutoff)", new { staleCutoff }),
                    weakHashes = conn.ExecuteScalar<long>("SELECT COUNT(*) FROM users WHERE is_enabled = 1 AND password_hash NOT LIKE '$2%'"),
                },
                groups = conn.ExecuteScalar<long>("SELECT COUNT(*) FROM groups"),
                rules = conn.ExecuteScalar<long>("SELECT COUNT(*) FROM access_rules"),
                repos = new
                {
                    active = repoList.Count(r => !r.IsArchived && !r.MissingOnDisk),
                    archived = repoList.Count(r => r.IsArchived),
                    missing = repoList.Count(r => r.MissingOnDisk),
                    totalBytes = repoList.Sum(r => r.SizeBytes ?? 0),
                    recent = repoList.Where(r => r.LastCommitAt is not null).OrderByDescending(r => r.LastCommitAt).Take(6),
                },
                backups = new
                {
                    settings = backups.GetSettings(),
                    running = backups.IsRunning,
                    lastRun = conn.QueryFirstOrDefault<BackupRun>("SELECT * FROM backup_runs WHERE kind = 'config' ORDER BY started_at DESC LIMIT 1"),
                    failedLast24h = conn.ExecuteScalar<long>("SELECT COUNT(*) FROM backup_runs WHERE kind = 'config' AND status = 'failed' AND started_at > @since",
                        new { since = DateTime.UtcNow.AddDays(-1).ToString("yyyy-MM-ddTHH:mm:ss.fffZ") }),
                },
                files = sync.Status(),
                recentAudit = conn.Query<AuditEntry>("SELECT * FROM audit_log WHERE action NOT LIKE 'auth.%' ORDER BY id DESC LIMIT 8"),
            };
        });
    }

    /// <param name="from">Entries at or after this instant.</param>
    /// <param name="to">Entries before this instant (exclusive), e.g. the start of the day after the last day wanted.</param>
    private static (string Where, DynamicParameters Args) AuditFilter(string? search, string? action, DateTimeOffset? from = null, DateTimeOffset? to = null)
    {
        var clauses = new List<string>();
        var args = new DynamicParameters();
        if (from is { } f) { clauses.Add("at >= @from"); args.Add("from", f.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")); }
        if (to is { } t) { clauses.Add("at < @to"); args.Add("to", t.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")); }
        if (!string.IsNullOrWhiteSpace(search))
        {
            clauses.Add("(actor LIKE @q OR target LIKE @q OR details LIKE @q OR action LIKE @q)");
            args.Add("q", "%" + search.Trim() + "%");
        }
        if (!string.IsNullOrWhiteSpace(action))
        {
            clauses.Add("action LIKE @a");
            args.Add("a", action.Trim() + "%");
        }
        return (clauses.Count == 0 ? "" : "WHERE " + string.Join(" AND ", clauses), args);
    }

    private static string Csv(string s)
    {
        // Guard against spreadsheet formula injection, then quote.
        if (s.Length > 0 && "=+-@\t\r".Contains(s[0])) s = "'" + s;
        return "\"" + s.Replace("\"", "\"\"") + "\"";
    }
}
