using System.Text;
using Dapper;
using Microsoft.Extensions.Options;
using SvnAdmin.Data;
using SvnAdmin.Security;
using SvnAdmin.Services;
using SvnAdmin.Svn;

namespace SvnAdmin.Endpoints;

/// <summary>Access review, inactive users, locks, offboarding, bulk actions and CSV import (admin only).</summary>
public static class ReportEndpoints
{
    public sealed record MatrixCell(string Access, bool Varies, string Via);
    public sealed record MatrixRow(string Username, string FullName, bool IsEnabled, List<string> Groups, Dictionary<string, MatrixCell> Repos);
    public sealed record BreakLocksRequest(List<LockRef> Locks);
    public sealed record LockRef(string Repo, string Path);
    public sealed record OffboardRequest(string? Reason, bool BreakLocks);
    public sealed record BulkRequest(List<string> Usernames, string Action, string? Group);
    public sealed record ImportRequest(string Csv, bool SendWelcome, bool DryRun);
    public sealed record ImportRow(int Line, string Username, string FullName, string Email, List<string> Groups, string Status, string? Password);

    public static void MapReports(this IEndpointRouteBuilder app)
    {
        // ------------------------------------------------------------ access grid
        app.MapGet("/api/reports/access", async (string? path, bool? includeDisabled, Db db, RepoService repos, CancellationToken ct) =>
        {
            var p = AuthzFile.NormalizePath(path ?? "/");
            var repoNames = (await repos.ListAsync(false, ct)).Where(r => !r.IsArchived).Select(r => r.Name).ToList();
            using var conn = db.Open();
            var eval = new AccessEvaluator(LoadRules(conn));
            var users = conn.Query<(string Username, string FullName, long IsEnabled)>(
                "SELECT username, full_name, is_enabled FROM users ORDER BY username COLLATE NOCASE");
            var rows = new List<MatrixRow>();
            foreach (var u in users.Where(u => includeDisabled == true || u.IsEnabled == 1))
            {
                var groups = Lookups.EffectiveGroups(conn, null, u.Username);
                var cells = repoNames.ToDictionary(r => r, r =>
                {
                    var res = eval.Evaluate(u.Username, groups, r, p);
                    return new MatrixCell(res.Access, eval.HasDeeperRules(u.Username, groups, r, p),
                        AccessEndpoints.SectionName(res.Repo, res.Path));
                });
                rows.Add(new MatrixRow(u.Username, u.FullName, u.IsEnabled == 1, groups.OrderBy(g => g).ToList(), cells));
            }
            return new { path = p, repos = repoNames, rows };
        });

        // ------------------------------------------------------------ inactive users
        app.MapGet("/api/reports/inactive", (int? days, Db db, ActivityScanner scanner, IOptions<SvnOptions> opt) =>
        {
            var d = Math.Clamp(days ?? opt.Value.DormantDays, 1, 3650);
            var cutoff = DateTime.UtcNow.AddDays(-d).ToString("yyyy-MM-ddTHH:mm:ss.fffZ");
            using var conn = db.Open();
            var rows = conn.Query<(string Username, string FullName, string Email, string CreatedAt, string? LastLoginAt, string? LastCommitAt, string? LastRepo, long? Commits)>("""
                SELECT u.username, u.full_name, u.email, u.created_at, u.last_login_at, a.last_commit_at, a.last_repo, a.commit_count
                FROM users u LEFT JOIN author_activity a ON a.username = u.username
                WHERE u.is_enabled = 1
                  AND (a.last_commit_at IS NULL OR a.last_commit_at < @cutoff)
                  AND (u.last_login_at IS NULL OR u.last_login_at < @cutoff)
                ORDER BY COALESCE(a.last_commit_at, '') , u.username COLLATE NOCASE
                """, new { cutoff });
            return new
            {
                days = d,
                lastScanUtc = scanner.LastRunUtc,
                users = rows.Select(r => new
                {
                    r.Username, r.FullName, r.Email, r.CreatedAt, r.LastLoginAt, r.LastCommitAt, r.LastRepo, commits = r.Commits ?? 0,
                    isNew = string.CompareOrdinal(r.CreatedAt, cutoff) > 0,
                    groups = Lookups.EffectiveGroups(conn, null, r.Username).OrderBy(g => g).ToList(),
                }),
            };
        });

        app.MapPost("/api/reports/rescan", async (ActivityScanner scanner, CancellationToken ct) =>
        {
            await scanner.ScanAsync(ct);
            return Results.NoContent();
        });

        // ------------------------------------------------------------ locks
        app.MapGet("/api/locks", async (RepoService repos, SvnCli svn, CancellationToken ct) =>
        {
            var list = (await repos.ListAsync(false, ct)).Where(r => !r.IsArchived && !r.MissingOnDisk);
            var all = await Task.WhenAll(list.Select(r => svn.LocksAsync(r.Name, repos.RepoPath(r.Name), ct)));
            return all.SelectMany(l => l).OrderBy(l => l.CreatedAt).ToList();
        });

        app.MapPost("/api/locks/break", async (BreakLocksRequest req, HttpContext ctx, Db db, RepoService repos, SvnCli svn, CancellationToken ct) =>
        {
            var actor = Actor.From(ctx);
            var results = new List<object>();
            foreach (var group in (req.Locks ?? []).GroupBy(l => l.Repo, StringComparer.OrdinalIgnoreCase))
            {
                Lookups.ValidateName(group.Key, "Repository name");
                var repoPath = repos.RepoPath(group.Key);
                if (!RepoService.LooksLikeRepo(repoPath)) throw new NotFoundException($"Repository '{group.Key}' not found.");
                var existing = (await svn.LocksAsync(group.Key, repoPath, ct)).ToDictionary(l => l.Path);
                var paths = group.Select(l => l.Path).Where(existing.ContainsKey).Distinct().ToList();
                if (paths.Count == 0) continue;
                var r = await svn.RemoveLocksAsync(repoPath, paths, ct);
                using var conn = db.Open();
                foreach (var p in paths)
                    Audit.Write(conn, null, actor, r.Ok ? "lock.break" : "lock.break.failed", $"{group.Key}:{p}",
                        $"Owner: {existing[p].Owner}" + (r.Ok ? "" : "\n" + r.StdErr.Trim()));
                results.Add(new { repo = group.Key, broken = r.Ok ? paths.Count : 0, error = r.Ok ? null : r.StdErr.Trim() });
            }
            return results;
        });

        // ------------------------------------------------------------ offboarding
        app.MapPost("/api/users/{username}/offboard", async (string username, OffboardRequest req, HttpContext ctx, ConfigSync sync,
            RepoService repos, SvnCli svn, Db db, CancellationToken ct) =>
        {
            var actor = Actor.From(ctx);
            if (username.Equals(actor.Name, StringComparison.OrdinalIgnoreCase)) throw new AppException("You can't offboard yourself.");
            var reason = (req.Reason ?? "").Trim();

            var summary = sync.Mutate(actor, (conn, tx) =>
            {
                var id = Lookups.UserId(conn, tx, username);
                var groups = conn.Query<string>("SELECT g.name FROM groups g JOIN group_user_members m ON m.group_id = g.id WHERE m.user_id = @id", new { id }, tx).ToList();
                var rules = conn.Execute("DELETE FROM access_rules WHERE principal_type = 'user' AND principal_name = @username", new { username }, tx);
                conn.Execute("DELETE FROM group_user_members WHERE user_id = @id", new { id }, tx);
                conn.Execute("UPDATE user_tokens SET used_at = @now WHERE user_id = @id AND used_at IS NULL", new { now = Clock.Now(), id }, tx);
                var note = $"Offboarded by {actor.Name} on {DateTime.UtcNow:yyyy-MM-dd}" + (reason == "" ? "" : $": {reason}") +
                           (groups.Count > 0 ? $". Was in: {string.Join(", ", groups)}" : "");
                conn.Execute("""
                    UPDATE users SET is_enabled = 0, offboarded_at = @now, updated_at = @now,
                      notes = CASE WHEN notes = '' THEN @note ELSE notes || char(10) || @note END
                    WHERE id = @id
                    """, new { now = Clock.Now(), note, id }, tx);
                Audit.Write(conn, tx, actor, "user.offboard", username, $"{note}. Removed {rules} direct permission(s).");
                return new { groups, removedRules = rules };
            });

            var brokenLocks = 0;
            if (req.BreakLocks)
            {
                foreach (var r in (await repos.ListAsync(false, ct)).Where(r => !r.IsArchived && !r.MissingOnDisk))
                {
                    var path = repos.RepoPath(r.Name);
                    var mine = (await svn.LocksAsync(r.Name, path, ct)).Where(l => l.Owner.Equals(username, StringComparison.OrdinalIgnoreCase)).ToList();
                    if (mine.Count == 0) continue;
                    var res = await svn.RemoveLocksAsync(path, mine.Select(l => l.Path), ct);
                    if (res.Ok) brokenLocks += mine.Count;
                    using var conn = db.Open();
                    Audit.Write(conn, null, actor, res.Ok ? "lock.break" : "lock.break.failed", r.Name,
                        $"Offboarding {username}: {string.Join(", ", mine.Select(l => l.Path))}");
                }
            }
            return new { summary.groups, summary.removedRules, brokenLocks };
        });

        // ------------------------------------------------------------ emailed links + MFA reset
        app.MapPost("/api/users/{username}/send-welcome", async (string username, HttpContext ctx, AccountLinks links) =>
        {
            await links.SendWelcomeAsync(username, Actor.From(ctx));
            return Results.NoContent();
        });

        app.MapPost("/api/users/{username}/send-reset", async (string username, HttpContext ctx, AccountLinks links) =>
        {
            await links.SendResetAsync(username, Actor.From(ctx));
            return Results.NoContent();
        });

        app.MapPost("/api/users/{username}/reset-mfa", (string username, HttpContext ctx, Db db) =>
        {
            var actor = Actor.From(ctx);
            if (username.Equals(actor.Name, StringComparison.OrdinalIgnoreCase))
                throw new AppException("Manage your own sign-in methods on the My account page.");
            using var conn = db.Open();
            var id = Lookups.UserId(conn, null, username);
            using var tx = conn.BeginTransaction();
            Mfa.ResetAll(conn, tx, id);
            Audit.Write(conn, tx, actor, "mfa.reset", username, "Authenticator app, recovery codes and passkeys removed by an admin.");
            tx.Commit();
            return Results.NoContent();
        });

        // ------------------------------------------------------------ bulk
        app.MapPost("/api/users/bulk", async (BulkRequest req, HttpContext ctx, ConfigSync sync, AccountLinks links, IOptions<SvnOptions> opt) =>
        {
            var actor = Actor.From(ctx);
            var names = (req.Usernames ?? []).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
            if (names.Count == 0) throw new AppException("Select at least one user.");

            if (req.Action == "send-reset")
            {
                var sent = 0; var errors = new List<string>();
                foreach (var n in names)
                {
                    try { await links.SendResetAsync(n, actor); sent++; }
                    catch (AppException ex) { errors.Add($"{n}: {ex.Message}"); }
                }
                return Results.Ok(new { done = sent, errors });
            }

            var done = sync.Mutate(actor, (conn, tx) =>
            {
                long? gid = req.Action is "add-group" or "remove-group" ? Lookups.GroupId(conn, tx, req.Group ?? "") : null;
                var count = 0;
                foreach (var n in names)
                {
                    var uid = Lookups.UserId(conn, tx, n);
                    count += req.Action switch
                    {
                        "add-group" => conn.Execute("INSERT OR IGNORE INTO group_user_members (group_id, user_id) VALUES (@gid, @uid)", new { gid, uid }, tx),
                        "remove-group" => conn.Execute("DELETE FROM group_user_members WHERE group_id = @gid AND user_id = @uid", new { gid, uid }, tx),
                        "disable" when n.Equals(actor.Name, StringComparison.OrdinalIgnoreCase) => throw new AppException("You can't disable yourself."),
                        "disable" => conn.Execute("UPDATE users SET is_enabled = 0, updated_at = @now WHERE id = @uid AND is_enabled = 1", new { uid, now = Clock.Now() }, tx),
                        "enable" => conn.Execute("UPDATE users SET is_enabled = 1, updated_at = @now WHERE id = @uid AND is_enabled = 0", new { uid, now = Clock.Now() }, tx),
                        _ => throw new AppException("Unknown bulk action."),
                    };
                }
                Lookups.EnsureAdminsRemain(conn, tx, actor, opt.Value.AdminGroup);
                Audit.Write(conn, tx, actor, "user.bulk." + req.Action, req.Group ?? "", $"{count} changed: {string.Join(", ", names)}");
                return count;
            });
            return Results.Ok(new { done, errors = Array.Empty<string>() });
        });

        // ------------------------------------------------------------ CSV import
        app.MapPost("/api/users/import", async (ImportRequest req, HttpContext ctx, ConfigSync sync, Db db, AccountLinks links,
            EmailSender email, IOptions<SvnOptions> opt) =>
        {
            var actor = Actor.From(ctx);
            var rows = ParseCsv(req.Csv ?? "");
            if (rows.Count > 500) throw new AppException("Import at most 500 users at a time.");
            using (var conn = db.Open())
            {
                var groups = conn.Query<string>("SELECT name FROM groups").ToHashSet(StringComparer.OrdinalIgnoreCase);
                var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                for (var i = 0; i < rows.Count; i++)
                {
                    var r = rows[i];
                    string? problem = null;
                    try { Lookups.ValidateName(r.Username, "Username"); } catch (AppException ex) { problem = ex.Message; }
                    problem ??= !seen.Add(r.Username) ? "Listed twice in the file."
                        : conn.ExecuteScalar<long>("SELECT COUNT(*) FROM users WHERE username = @Username", r) > 0 ? "Already exists."
                        : r.Groups.FirstOrDefault(g => !groups.Contains(g)) is { } bad ? $"Group '{bad}' doesn't exist."
                        : req.SendWelcome && string.IsNullOrWhiteSpace(r.Email) ? "No email address for the welcome email."
                        : null;
                    rows[i] = r with { Status = problem ?? "ok" };
                }
            }
            if (req.SendWelcome && !email.IsConfigured) throw new AppException("Email isn't set up, so welcome emails can't be sent.");
            if (req.DryRun || rows.Any(r => r.Status != "ok")) return Results.Ok(new { created = 0, rows });

            var created = rows.Select(r => r with { Password = req.SendWelcome ? null : Security.PasswordGenerator.New() }).ToList();
            sync.Mutate(actor, (conn, tx) =>
            {
                var now = Clock.Now();
                foreach (var r in created)
                {
                    var pw = r.Password ?? Security.PasswordGenerator.New(32); // welcome users set their own
                    var id = conn.ExecuteScalar<long>("""
                        INSERT INTO users (username, full_name, email, password_hash, is_enabled, password_changed_at, created_at, updated_at)
                        VALUES (@Username, @FullName, @Email, @h, 1, @pca, @now, @now) RETURNING id
                        """, new { r.Username, r.FullName, r.Email, h = HtpasswdHash.Create(pw), pca = r.Password is null ? null : now, now }, tx);
                    foreach (var g in r.Groups)
                        conn.Execute("INSERT INTO group_user_members (group_id, user_id) VALUES (@gid, @id)", new { gid = Lookups.GroupId(conn, tx, g), id }, tx);
                }
                Audit.Write(conn, tx, actor, "user.import", "", $"{created.Count} users: {string.Join(", ", created.Select(r => r.Username))}");
            });

            if (req.SendWelcome)
                foreach (var r in created)
                {
                    try { await links.SendWelcomeAsync(r.Username, actor); }
                    catch (AppException ex) { created[created.IndexOf(r)] = r with { Status = "created, but email failed: " + ex.Message }; }
                }
            return Results.Ok(new { created = created.Count, rows = created });
        });
    }

    private static List<AuthzRule> LoadRules(System.Data.IDbConnection conn) => conn.Query<AuthzRule>(
        "SELECT repo_name AS Repo, path AS Path, principal_type AS PrincipalType, principal_name AS PrincipalName, access AS Access FROM access_rules").ToList();

    /// <summary>CSV columns: username, full name, email, groups (separated by ; or |). A header row is optional.</summary>
    public static List<ImportRow> ParseCsv(string csv)
    {
        var rows = new List<ImportRow>();
        var lines = csv.Replace("\r\n", "\n").Split('\n');
        for (var i = 0; i < lines.Length; i++)
        {
            var line = lines[i].Trim();
            if (line.Length == 0 || line.StartsWith('#')) continue;
            var f = SplitCsvLine(line);
            if (i == 0 && f.Count > 0 && f[0].Equals("username", StringComparison.OrdinalIgnoreCase)) continue;
            string F(int n) => n < f.Count ? f[n].Trim() : "";
            var groups = F(3).Split([';', '|'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList();
            rows.Add(new ImportRow(i + 1, F(0), F(1), F(2), groups, "", null));
        }
        return rows;
    }

    private static List<string> SplitCsvLine(string line)
    {
        var fields = new List<string>();
        var sb = new StringBuilder();
        var quoted = false;
        for (var i = 0; i < line.Length; i++)
        {
            var c = line[i];
            if (quoted)
            {
                if (c == '"' && i + 1 < line.Length && line[i + 1] == '"') { sb.Append('"'); i++; }
                else if (c == '"') quoted = false;
                else sb.Append(c);
            }
            else if (c == '"') quoted = true;
            else if (c == ',') { fields.Add(sb.ToString()); sb.Clear(); }
            else sb.Append(c);
        }
        fields.Add(sb.ToString());
        return fields;
    }
}
