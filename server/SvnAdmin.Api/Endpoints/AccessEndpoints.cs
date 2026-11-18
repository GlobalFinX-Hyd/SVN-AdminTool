using Dapper;
using SvnAdmin.Data;
using SvnAdmin.Services;
using SvnAdmin.Svn;

namespace SvnAdmin.Endpoints;

public static class AccessEndpoints
{
    public sealed record RuleDto(string PrincipalType, string PrincipalName, string Access);
    public sealed record SectionDto(string? Repo, string Path, List<RuleDto> Rules);
    public sealed record SaveSectionRequest(string? Repo, string Path, string? OriginalPath, List<RuleDto> Rules);

    private static readonly string[] PrincipalTypes = ["user", "group", "all", "authenticated", "anonymous"];

    public static void MapAccess(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/access");

        // ?repo=name for one repository (plus the all-repository sections that also apply to it); omit for everything.
        g.MapGet("/", (string? repo, Db db) =>
        {
            using var conn = db.Open();
            return LoadSections(conn, repo);
        });

        g.MapPut("/section", (SaveSectionRequest req, HttpContext ctx, ConfigSync sync) =>
        {
            var repo = string.IsNullOrWhiteSpace(req.Repo) ? null : req.Repo.Trim();
            var path = AuthzFile.NormalizePath(req.Path ?? "/");
            var original = req.OriginalPath is null ? path : AuthzFile.NormalizePath(req.OriginalPath);
            if (path.Contains(']') || path.Contains('[') || path.Contains('\n'))
                throw new AppException("Path contains characters that cannot be used in an authz section.");

            var rules = (req.Rules ?? []).Select(r => r with
            {
                PrincipalType = r.PrincipalType?.Trim().ToLowerInvariant() ?? "",
                PrincipalName = r.PrincipalType is "user" or "group" ? r.PrincipalName?.Trim() ?? "" : "",
                Access = r.Access?.Trim() ?? "",
            }).ToList();

            foreach (var r in rules)
            {
                if (!PrincipalTypes.Contains(r.PrincipalType)) throw new AppException($"Unknown principal type '{r.PrincipalType}'.");
                if (r.Access is not ("" or "r" or "rw")) throw new AppException("Access must be none, read (r) or read/write (rw).");
            }
            var dupes = rules.GroupBy(r => (r.PrincipalType, r.PrincipalName.ToLowerInvariant())).Where(x => x.Count() > 1).ToList();
            if (dupes.Count > 0)
                throw new AppException($"{AuthzFile.PrincipalKey(dupes[0].Key.PrincipalType, dupes[0].First().PrincipalName)} is listed more than once.");

            var actor = Actor.From(ctx);
            sync.Mutate(actor, (conn, tx) =>
            {
                if (repo is not null && conn.ExecuteScalar<long>("SELECT COUNT(*) FROM repositories WHERE name = @repo", new { repo }, tx) == 0)
                    throw new NotFoundException($"Repository '{repo}' not found.");
                foreach (var r in rules.Where(r => r.PrincipalType == "user")) Lookups.UserId(conn, tx, r.PrincipalName);
                foreach (var r in rules.Where(r => r.PrincipalType == "group")) Lookups.GroupId(conn, tx, r.PrincipalName);

                var before = conn.Query<RuleDto>(
                    "SELECT principal_type AS PrincipalType, principal_name AS PrincipalName, access AS Access FROM access_rules WHERE repo_name IS @repo AND path = @original",
                    new { repo, original }, tx).ToList();

                if (original != path &&
                    conn.ExecuteScalar<long>("SELECT COUNT(*) FROM access_rules WHERE repo_name IS @repo AND path = @path", new { repo, path }, tx) > 0)
                    throw new ConflictException($"Permissions for {SectionName(repo, path)} already exist. Edit that section instead.");

                conn.Execute("DELETE FROM access_rules WHERE repo_name IS @repo AND path = @original", new { repo, original }, tx);
                foreach (var r in rules)
                    conn.Execute("""
                        INSERT INTO access_rules (repo_name, path, principal_type, principal_name, access)
                        VALUES (@repo, @path, @PrincipalType, @PrincipalName, @Access)
                        """, new { repo, path, r.PrincipalType, r.PrincipalName, r.Access }, tx);

                Audit.Write(conn, tx, actor, rules.Count == 0 ? "access.delete" : "access.update", SectionName(repo, path),
                    $"Before: {Describe(before)}\nAfter: {Describe(rules)}");
            });
            return Results.NoContent();
        });

        g.MapDelete("/section", (string? repo, string path, HttpContext ctx, ConfigSync sync) =>
        {
            repo = string.IsNullOrWhiteSpace(repo) ? null : repo;
            path = AuthzFile.NormalizePath(path);
            var actor = Actor.From(ctx);
            sync.Mutate(actor, (conn, tx) =>
            {
                var before = conn.Query<RuleDto>(
                    "SELECT principal_type AS PrincipalType, principal_name AS PrincipalName, access AS Access FROM access_rules WHERE repo_name IS @repo AND path = @path",
                    new { repo, path }, tx).ToList();
                if (before.Count == 0) throw new NotFoundException($"No permissions found for {SectionName(repo, path)}.");
                conn.Execute("DELETE FROM access_rules WHERE repo_name IS @repo AND path = @path", new { repo, path }, tx);
                Audit.Write(conn, tx, actor, "access.delete", SectionName(repo, path), $"Before: {Describe(before)}");
            });
            return Results.NoContent();
        });
    }

    public static string SectionName(string? repo, string path) => $"[{(repo is null ? "" : repo + ":")}{path}]";

    private static string Describe(IEnumerable<RuleDto> rules) =>
        rules.Any() ? string.Join(", ", rules.Select(r => $"{AuthzFile.PrincipalKey(r.PrincipalType, r.PrincipalName)}={(r.Access == "" ? "none" : r.Access)}")) : "(none)";

    public static List<SectionDto> LoadSections(System.Data.IDbConnection conn, string? repo)
    {
        var rows = conn.Query<(string? RepoName, string Path, string PrincipalType, string PrincipalName, string Access)>("""
            SELECT repo_name, path, principal_type, principal_name, access FROM access_rules
            WHERE @repo IS NULL OR repo_name IS NULL OR repo_name = @repo
            """, new { repo });
        return rows
            .GroupBy(r => (r.RepoName, r.Path))
            .OrderBy(s => s.Key.RepoName is null ? 0 : 1)
            .ThenBy(s => s.Key.RepoName, StringComparer.OrdinalIgnoreCase)
            .ThenBy(s => s.Key.Path, StringComparer.Ordinal)
            .Select(s => new SectionDto(s.Key.RepoName, s.Key.Path, s
                .OrderBy(r => r.PrincipalType switch { "all" => 0, "authenticated" => 1, "anonymous" => 2, "group" => 3, _ => 4 })
                .ThenBy(r => r.PrincipalName, StringComparer.OrdinalIgnoreCase)
                .Select(r => new RuleDto(r.PrincipalType, r.PrincipalName, r.Access)).ToList()))
            .ToList();
    }
}
