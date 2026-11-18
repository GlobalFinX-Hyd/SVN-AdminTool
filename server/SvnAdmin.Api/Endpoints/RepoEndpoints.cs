using Dapper;
using SvnAdmin.Data;
using SvnAdmin.Services;
using SvnAdmin.Svn;

namespace SvnAdmin.Endpoints;

public static class RepoEndpoints
{
    public sealed record GrantDto(string PrincipalType, string PrincipalName, string Access);
    public sealed record CreateRepoRequest(string Name, string? Description, bool CreateLayout, List<GrantDto>? Grants);
    public sealed record UpdateRepoRequest(string? Description);

    public static void MapRepos(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/repos");

        g.MapGet("/", (RepoService repos, CancellationToken ct) => repos.ListAsync(includeDetails: true, ct));

        g.MapPost("/", async (CreateRepoRequest req, HttpContext ctx, RepoService repos, ConfigSync sync, CancellationToken ct) =>
        {
            var name = (req.Name ?? "").Trim();
            Lookups.ValidateName(name, "Repository name");
            var grants = req.Grants ?? [];
            foreach (var gr in grants)
            {
                if (gr.PrincipalType is not ("user" or "group" or "all" or "authenticated")) throw new AppException("Invalid grant.");
                if (gr.Access is not ("r" or "rw")) throw new AppException("Initial access must be read or read/write.");
            }
            var actor = Actor.From(ctx);

            using (var check = ctx.RequestServices.GetRequiredService<Db>().Open())
                if (check.ExecuteScalar<long>("SELECT COUNT(*) FROM repositories WHERE name = @name", new { name }) > 0)
                    throw new ConflictException($"Repository '{name}' already exists (it may be archived).");

            await repos.CreateOnDiskAsync(name, req.CreateLayout, actor, ct);
            try
            {
                sync.Mutate(actor, (conn, tx) =>
                {
                    conn.Execute("INSERT INTO repositories (name, description, created_at) VALUES (@name, @d, @now)",
                        new { name, d = req.Description?.Trim() ?? "", now = Clock.Now() }, tx);
                    foreach (var gr in grants)
                    {
                        if (gr.PrincipalType == "user") Lookups.UserId(conn, tx, gr.PrincipalName);
                        if (gr.PrincipalType == "group") Lookups.GroupId(conn, tx, gr.PrincipalName);
                        conn.Execute("""
                            INSERT INTO access_rules (repo_name, path, principal_type, principal_name, access)
                            VALUES (@name, '/', @PrincipalType, @pn, @Access)
                            """, new { name, gr.PrincipalType, pn = gr.PrincipalType is "user" or "group" ? gr.PrincipalName : "", gr.Access }, tx);
                    }
                    Audit.Write(conn, tx, actor, "repo.create", name,
                        $"Layout: {(req.CreateLayout ? "trunk/branches/tags" : "empty")}. Access: " +
                        (grants.Count == 0 ? "none added" : string.Join(", ", grants.Select(x => $"{AuthzFile.PrincipalKey(x.PrincipalType, x.PrincipalName)}={x.Access}"))));
                });
            }
            catch
            {
                repos.TryDelete(repos.RepoPath(name)); // brand new and empty, safe to remove
                throw;
            }
            var created = (await repos.ListAsync(true, ct)).Single(r => r.Name.Equals(name, StringComparison.OrdinalIgnoreCase));
            return Results.Created($"/api/repos/{name}", created);
        });

        g.MapPut("/{name}", (string name, UpdateRepoRequest req, HttpContext ctx, Db db) =>
        {
            using var conn = db.Open();
            if (conn.Execute("UPDATE repositories SET description = @d WHERE name = @name", new { d = req.Description?.Trim() ?? "", name }) == 0)
                throw new NotFoundException($"Repository '{name}' not found.");
            Audit.Write(conn, null, Actor.From(ctx), "repo.update", name, $"Description: {req.Description}");
            return Results.NoContent();
        });

        g.MapPost("/{name}/archive", (string name, HttpContext ctx, Db db, RepoService repos) =>
        {
            using var conn = db.Open();
            var exists = conn.ExecuteScalar<long?>("SELECT is_archived FROM repositories WHERE name = @name", new { name })
                ?? throw new NotFoundException($"Repository '{name}' not found.");
            if (exists == 1) throw new AppException("Repository is already archived.");
            var dest = repos.Archive(name);
            conn.Execute("UPDATE repositories SET is_archived = 1, archived_at = @now WHERE name = @name", new { now = Clock.Now(), name });
            Audit.Write(conn, null, Actor.From(ctx), "repo.archive", name, $"Moved to {dest}. Its permissions are kept for a restore.");
            return Results.NoContent();
        });

        g.MapPost("/{name}/restore", (string name, HttpContext ctx, Db db, RepoService repos) =>
        {
            using var conn = db.Open();
            var archived = conn.ExecuteScalar<long?>("SELECT is_archived FROM repositories WHERE name = @name", new { name })
                ?? throw new NotFoundException($"Repository '{name}' not found.");
            if (archived == 0) throw new AppException("Repository is not archived.");
            var src = repos.Restore(name);
            conn.Execute("UPDATE repositories SET is_archived = 0, archived_at = NULL WHERE name = @name", new { name });
            Audit.Write(conn, null, Actor.From(ctx), "repo.restore", name, $"Restored from {src}.");
            return Results.NoContent();
        });

        g.MapGet("/{name}/tree", async (string name, string? path, RepoService repos, SvnCli svn, CancellationToken ct) =>
        {
            var repoPath = ActiveRepoPath(repos, name);
            return await svn.ListAsync(repoPath, AuthzFile.NormalizePath(path ?? "/"), ct);
        });

        g.MapGet("/{name}/log", async (string name, int? limit, RepoService repos, SvnCli svn, CancellationToken ct) =>
        {
            var repoPath = ActiveRepoPath(repos, name);
            return await svn.LogAsync(name, repoPath, Math.Clamp(limit ?? 50, 1, 500), verbose: true, ct);
        });

        app.MapGet("/api/activity", async (int? limit, string? author, RepoService repos, SvnCli svn, CancellationToken ct) =>
        {
            var n = Math.Clamp(limit ?? 50, 1, 300);
            var list = await repos.ListAsync(includeDetails: false, ct);
            var logs = await Task.WhenAll(list.Where(r => !r.IsArchived && !r.MissingOnDisk)
                .Select(r => svn.LogAsync(r.Name, repos.RepoPath(r.Name), n, verbose: true, ct)));
            return logs.SelectMany(l => l)
                .Where(e => string.IsNullOrWhiteSpace(author) || e.Author.Equals(author, StringComparison.OrdinalIgnoreCase))
                .OrderByDescending(e => e.Date)
                .Take(n)
                .ToList();
        });
    }

    private static string ActiveRepoPath(RepoService repos, string name)
    {
        Lookups.ValidateName(name, "Repository name");
        var path = repos.RepoPath(name);
        if (!RepoService.LooksLikeRepo(path)) throw new NotFoundException($"Repository '{name}' not found on disk.");
        return path;
    }
}
