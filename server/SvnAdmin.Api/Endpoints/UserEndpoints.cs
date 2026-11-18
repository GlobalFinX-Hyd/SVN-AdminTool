using Dapper;
using Microsoft.Extensions.Options;
using SvnAdmin.Data;
using SvnAdmin.Security;
using SvnAdmin.Services;
using SvnAdmin.Svn;

namespace SvnAdmin.Endpoints;

public static class UserEndpoints
{
    public sealed record UserDto(
        string Username, string FullName, string Email, string Notes, bool IsEnabled, bool IsAdmin,
        List<string> Groups, string? PasswordChangedAt, int? PasswordAgeDays, bool PasswordStale, bool WeakHash,
        string? LastAdminLoginAt, string? LockedUntil, string CreatedAt,
        bool HasMfa, bool InvitePending, string? LastLoginAt, string? LastCommitAt, string? OffboardedAt);

    public sealed record CreateUserRequest(string Username, string? FullName, string? Email, string? Password, List<string>? Groups, string? Notes, bool SendWelcome);
    public sealed record UpdateUserRequest(string? FullName, string? Email, string? Notes, bool IsEnabled, List<string>? Groups);
    public sealed record SetPasswordRequest(string Password);
    public sealed record AccessEntry(string? Repo, string Path, string Via, string Access);

    public static void MapUsers(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/users");

        g.MapGet("/", (Db db, ConfigSync sync, IOptions<SvnOptions> opt) =>
        {
            sync.ReconcileIfChanged();
            using var conn = db.Open();
            return LoadUsers(conn, opt.Value);
        });

        g.MapGet("/{username}", (string username, Db db, ConfigSync sync, IOptions<SvnOptions> opt) =>
        {
            sync.ReconcileIfChanged();
            using var conn = db.Open();
            return LoadUsers(conn, opt.Value, username).FirstOrDefault() ?? throw new NotFoundException($"User '{username}' not found.");
        });

        g.MapPost("/", async (CreateUserRequest req, HttpContext ctx, ConfigSync sync, IOptions<SvnOptions> opt, Db db, AccountLinks links, EmailSender email) =>
        {
            var username = (req.Username ?? "").Trim();
            Lookups.ValidateName(username, "Username");
            if (req.SendWelcome)
            {
                if (!email.IsConfigured) throw new AppException("Email isn't set up, so a welcome email can't be sent. Set a password instead.");
                if (string.IsNullOrWhiteSpace(req.Email)) throw new AppException("Enter an email address to send the welcome email to.");
            }
            else
            {
                Lookups.ValidatePassword(req.Password, username, opt.Value.MinPasswordLength);
            }
            var actor = Actor.From(ctx);
            // With a welcome email the user picks their own password; until then the account has an unknown random one.
            var hash = HtpasswdHash.Create(req.SendWelcome ? PasswordGenerator.New(32) : req.Password!);

            sync.Mutate(actor, (conn, tx) =>
            {
                if (conn.ExecuteScalar<long>("SELECT COUNT(*) FROM users WHERE username = @username", new { username }, tx) > 0)
                    throw new ConflictException($"User '{username}' already exists.");
                var now = Clock.Now();
                var id = conn.ExecuteScalar<long>("""
                    INSERT INTO users (username, full_name, email, notes, password_hash, is_enabled, password_changed_at, created_at, updated_at)
                    VALUES (@username, @fullName, @email, @notes, @hash, 1, @pca, @now, @now) RETURNING id
                    """, new { username, fullName = req.FullName?.Trim() ?? "", email = req.Email?.Trim() ?? "", notes = req.Notes ?? "", hash, pca = req.SendWelcome ? null : now, now }, tx);
                SetGroups(conn, tx, id, req.Groups ?? []);
                Audit.Write(conn, tx, actor, "user.create", username, $"Groups: {string.Join(", ", req.Groups ?? [])}");
            });
            if (req.SendWelcome) await links.SendWelcomeAsync(username, actor);
            using var c = db.Open();
            return Results.Created($"/api/users/{username}", LoadUsers(c, opt.Value, username).Single());
        });

        g.MapPut("/{username}", (string username, UpdateUserRequest req, HttpContext ctx, ConfigSync sync, IOptions<SvnOptions> opt, Db db) =>
        {
            var actor = Actor.From(ctx);
            sync.Mutate(actor, (conn, tx) =>
            {
                var id = Lookups.UserId(conn, tx, username);
                var before = conn.QuerySingle<(string FullName, string Email, long IsEnabled)>(
                    "SELECT full_name, email, is_enabled FROM users WHERE id = @id", new { id }, tx);
                var beforeGroups = DirectGroups(conn, tx, id);

                conn.Execute("""
                    UPDATE users SET full_name = @fullName, email = @email, notes = @notes, is_enabled = @enabled, updated_at = @now
                    WHERE id = @id
                    """, new { id, fullName = req.FullName?.Trim() ?? "", email = req.Email?.Trim() ?? "", notes = req.Notes ?? "", enabled = req.IsEnabled ? 1 : 0, now = Clock.Now() }, tx);
                if (req.Groups is not null) SetGroups(conn, tx, id, req.Groups);
                Lookups.EnsureAdminsRemain(conn, tx, actor, opt.Value.AdminGroup);

                var changes = new List<string>();
                if (before.IsEnabled == 1 != req.IsEnabled) changes.Add(req.IsEnabled ? "enabled" : "disabled");
                if (before.FullName != (req.FullName?.Trim() ?? "")) changes.Add($"name: '{before.FullName}' → '{req.FullName}'");
                if (before.Email != (req.Email?.Trim() ?? "")) changes.Add($"email: '{before.Email}' → '{req.Email}'");
                if (req.Groups is not null)
                {
                    var added = req.Groups.Except(beforeGroups, StringComparer.OrdinalIgnoreCase).ToList();
                    var removed = beforeGroups.Except(req.Groups, StringComparer.OrdinalIgnoreCase).ToList();
                    if (added.Count > 0) changes.Add("added to " + string.Join(", ", added));
                    if (removed.Count > 0) changes.Add("removed from " + string.Join(", ", removed));
                }
                Audit.Write(conn, tx, actor, "user.update", username, string.Join("; ", changes));
            });
            using var c = db.Open();
            return LoadUsers(c, opt.Value, username).Single();
        });

        g.MapPost("/{username}/password", (string username, SetPasswordRequest req, HttpContext ctx, ConfigSync sync, IOptions<SvnOptions> opt) =>
        {
            Lookups.ValidatePassword(req.Password, username, opt.Value.MinPasswordLength);
            var actor = Actor.From(ctx);
            var hash = HtpasswdHash.Create(req.Password);
            sync.Mutate(actor, (conn, tx) =>
            {
                var id = Lookups.UserId(conn, tx, username);
                var now = Clock.Now();
                conn.Execute("""
                    UPDATE users SET password_hash = @hash, password_changed_at = @now, updated_at = @now, failed_logins = 0, locked_until = NULL
                    WHERE id = @id
                    """, new { hash, now, id }, tx);
                Audit.Write(conn, tx, actor, "user.password.reset", username);
            });
            return Results.NoContent();
        });

        g.MapPost("/{username}/unlock", (string username, HttpContext ctx, Db db) =>
        {
            using var conn = db.Open();
            Lookups.UserId(conn, null, username);
            conn.Execute("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE username = @username", new { username });
            Audit.Write(conn, null, Actor.From(ctx), "user.unlock", username);
            return Results.NoContent();
        });

        g.MapDelete("/{username}", (string username, HttpContext ctx, ConfigSync sync) =>
        {
            var actor = Actor.From(ctx);
            if (username.Equals(actor.Name, StringComparison.OrdinalIgnoreCase))
                throw new AppException("You cannot delete your own account.");
            var removedRules = sync.Mutate(actor, (conn, tx) =>
            {
                var id = Lookups.UserId(conn, tx, username);
                var groups = DirectGroups(conn, tx, id);
                var rules = conn.Execute("DELETE FROM access_rules WHERE principal_type = 'user' AND principal_name = @username", new { username }, tx);
                conn.Execute("DELETE FROM users WHERE id = @id", new { id }, tx);
                Audit.Write(conn, tx, actor, "user.delete", username,
                    $"Was in: {string.Join(", ", groups)}. Removed {rules} direct permission(s).");
                return rules;
            });
            return Results.Ok(new { removedRules });
        });

        g.MapGet("/{username}/access", (string username, Db db) =>
        {
            using var conn = db.Open();
            Lookups.UserId(conn, null, username);
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
                .Select(r => new AccessEntry(r.Repo, r.Path, AuthzFile.PrincipalKey(r.PrincipalType, r.PrincipalName), r.Access))
                .OrderBy(r => r.Repo ?? "").ThenBy(r => r.Path)
                .ToList();
        });
    }

    private static List<string> DirectGroups(System.Data.IDbConnection conn, System.Data.IDbTransaction tx, long userId) =>
        conn.Query<string>("SELECT g.name FROM groups g JOIN group_user_members m ON m.group_id = g.id WHERE m.user_id = @userId",
            new { userId }, tx).ToList();

    private static void SetGroups(System.Data.IDbConnection conn, System.Data.IDbTransaction tx, long userId, List<string> groups)
    {
        conn.Execute("DELETE FROM group_user_members WHERE user_id = @userId", new { userId }, tx);
        foreach (var name in groups.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            var gid = Lookups.GroupId(conn, tx, name);
            conn.Execute("INSERT INTO group_user_members (group_id, user_id) VALUES (@gid, @userId)", new { gid, userId }, tx);
        }
    }

    private sealed class UserRow
    {
        public long Id { get; set; }
        public string Username { get; set; } = "";
        public string FullName { get; set; } = "";
        public string Email { get; set; } = "";
        public string Notes { get; set; } = "";
        public long IsEnabled { get; set; }
        public string PasswordHash { get; set; } = "";
        public string? PasswordChangedAt { get; set; }
        public string? LastAdminLoginAt { get; set; }
        public string? LastLoginAt { get; set; }
        public string? LockedUntil { get; set; }
        public string CreatedAt { get; set; } = "";
        public string? OffboardedAt { get; set; }
        public long HasMfa { get; set; }
        public long InvitePending { get; set; }
        public string? LastCommitAt { get; set; }
    }

    private static List<UserDto> LoadUsers(System.Data.IDbConnection conn, SvnOptions o, string? only = null)
    {
        var rows = conn.Query<UserRow>("""
            SELECT u.id, u.username, u.full_name, u.email, u.notes, u.is_enabled, u.password_hash, u.password_changed_at,
                   u.last_admin_login_at, u.last_login_at, u.locked_until, u.created_at, u.offboarded_at,
                   (u.totp_secret IS NOT NULL OR EXISTS (SELECT 1 FROM passkeys p WHERE p.user_id = u.id)) AS has_mfa,
                   EXISTS (SELECT 1 FROM user_tokens t WHERE t.user_id = u.id AND t.purpose = 'welcome' AND t.used_at IS NULL AND t.expires_at > @now) AS invite_pending,
                   a.last_commit_at
            FROM users u LEFT JOIN author_activity a ON a.username = u.username
            WHERE (@only IS NULL OR u.username = @only) ORDER BY u.username COLLATE NOCASE
            """, new { only, now = Clock.Now() });
        var memberships = conn.Query<(long UserId, string Name)>(
            "SELECT m.user_id, g.name FROM group_user_members m JOIN groups g ON g.id = m.group_id ORDER BY g.name COLLATE NOCASE")
            .ToLookup(x => x.UserId, x => x.Name);

        return rows.Select(r =>
        {
            int? age = r.PasswordChangedAt is null ? null : (int)(DateTime.UtcNow - DateTime.Parse(r.PasswordChangedAt).ToUniversalTime()).TotalDays;
            var locked = Sessions.IsLocked(r.LockedUntil) ? r.LockedUntil : null;
            return new UserDto(r.Username, r.FullName, r.Email, r.Notes, r.IsEnabled == 1,
                Lookups.IsAdmin(conn, null, r.Username, o.AdminGroup),
                memberships[r.Id].ToList(), r.PasswordChangedAt, age,
                o.PasswordMaxAgeDays > 0 && age > o.PasswordMaxAgeDays && r.InvitePending == 0,
                HtpasswdHash.IsWeakFormat(r.PasswordHash),
                r.LastAdminLoginAt, locked, r.CreatedAt,
                r.HasMfa == 1, r.InvitePending == 1, r.LastLoginAt, r.LastCommitAt, r.OffboardedAt);
        }).ToList();
    }
}