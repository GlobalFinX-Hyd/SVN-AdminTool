using System.Collections.Concurrent;
using Dapper;
using Microsoft.Extensions.Options;
using SvnAdmin.Data;
using SvnAdmin.Svn;

namespace SvnAdmin.Services;

public sealed record RepoDto(
    string Name, string Description, bool IsArchived, string? ArchivedAt, bool MissingOnDisk, string Url,
    long? Revision, string? LastAuthor, DateTime? LastCommitAt, string? LastMessage, long? SizeBytes, string CreatedAt);

/// <summary>Repository folders on disk under SVNParentPath, plus their records in the database.</summary>
public sealed class RepoService(Db db, SvnCli svn, IOptions<SvnOptions> options, ILogger<RepoService> logger)
{
    private readonly SvnOptions _o = options.Value;
    private readonly ConcurrentDictionary<string, (DateTime At, long Size)> _sizeCache = new(StringComparer.OrdinalIgnoreCase);

    public string RepoPath(string name) => Path.Combine(_o.RepositoriesRoot, name);

    public static bool LooksLikeRepo(string dir) =>
        File.Exists(Path.Combine(dir, "format")) && Directory.Exists(Path.Combine(dir, "db"));

    /// <summary>Adds database records for repositories created outside SvnAdmin.</summary>
    public void SyncFromDisk()
    {
        if (!Directory.Exists(_o.RepositoriesRoot)) return;
        using var conn = db.Open();
        foreach (var dir in Directory.EnumerateDirectories(_o.RepositoriesRoot).Where(LooksLikeRepo))
        {
            var name = Path.GetFileName(dir);
            var added = conn.Execute(
                "INSERT OR IGNORE INTO repositories (name, created_at) VALUES (@name, @at)",
                new { name, at = Directory.GetCreationTimeUtc(dir).ToString("yyyy-MM-ddTHH:mm:ss.fffZ") });
            if (added > 0)
            {
                Audit.Write(conn, null, Actor.System, "repo.discover", name, "Found on disk; added to SvnAdmin.");
                logger.LogInformation("Discovered repository {Name}", name);
            }
        }
    }

    public async Task<List<RepoDto>> ListAsync(bool includeDetails, CancellationToken ct)
    {
        SyncFromDisk();
        using var conn = db.Open();
        var rows = conn.Query<(string Name, string Description, long IsArchived, string? ArchivedAt, string CreatedAt)>(
            "SELECT name, description, is_archived, archived_at, created_at FROM repositories ORDER BY name COLLATE NOCASE").ToList();

        var tasks = rows.Select(async r =>
        {
            var path = RepoPath(r.Name);
            var onDisk = r.IsArchived == 0 && LooksLikeRepo(path);
            long? rev = null; string? author = null; DateTime? at = null; string? msg = null; long? size = null;
            if (includeDetails && onDisk)
            {
                var last = (await svn.LogAsync(r.Name, path, 1, false, ct)).FirstOrDefault();
                rev = last?.Revision ?? await svn.YoungestAsync(path, ct);
                author = last?.Author; at = last?.Date; msg = last?.Message;
                size = Size(path);
            }
            return new RepoDto(r.Name, r.Description, r.IsArchived == 1, r.ArchivedAt, r.IsArchived == 0 && !onDisk,
                PublicUrl(r.Name), rev, author, at, msg, size, r.CreatedAt);
        });
        return [.. await Task.WhenAll(tasks)];
    }

    public string PublicUrl(string name) =>
        string.IsNullOrWhiteSpace(_o.PublicUrl) ? "" : _o.PublicUrl.TrimEnd('/') + "/" + Uri.EscapeDataString(name);

    public async Task CreateOnDiskAsync(string name, bool layout, Actor actor, CancellationToken ct)
    {
        var path = RepoPath(name);
        if (Directory.Exists(path)) throw new ConflictException($"A folder named '{name}' already exists in the repositories folder.");
        Directory.CreateDirectory(_o.RepositoriesRoot);

        var r = await svn.RunAsync("svnadmin", ["create", path], TimeSpan.FromMinutes(2), ct);
        if (!r.Ok) throw new AppException("svnadmin create failed: " + r.StdErr.Trim());

        if (layout)
        {
            var root = SvnCli.FileUrl(path);
            var mk = await svn.RunAsync("svn",
                ["mkdir", "--non-interactive", "--username", actor.Name, "-m", "Create standard layout (trunk, branches, tags)",
                 root + "/trunk", root + "/branches", root + "/tags"], ct: ct);
            if (!mk.Ok)
            {
                TryDelete(path);
                throw new AppException("Repository created but the trunk/branches/tags layout failed: " + mk.StdErr.Trim());
            }
        }
    }

    public void TryDelete(string path)
    {
        try { Directory.Delete(path, recursive: true); }
        catch (Exception ex) { logger.LogWarning(ex, "Could not remove {Path}", path); }
    }

    /// <summary>Moves the repository folder out of SVNParentPath so Apache stops serving it. Nothing is deleted.</summary>
    public string Archive(string name)
    {
        if (string.IsNullOrWhiteSpace(_o.ArchiveRoot)) throw new AppException("Svn:ArchiveRoot is not set in appsettings.json.");
        var src = RepoPath(name);
        if (!LooksLikeRepo(src)) throw new NotFoundException($"Repository folder not found: {src}");
        Directory.CreateDirectory(_o.ArchiveRoot);
        var dest = Path.Combine(_o.ArchiveRoot, $"{name}.{DateTime.UtcNow:yyyyMMdd-HHmmss}");
        try
        {
            Directory.Move(src, dest);
        }
        catch (IOException ex)
        {
            throw new AppException($"Could not move the repository (it may be in use, or ArchiveRoot is on another drive): {ex.Message}");
        }
        return dest;
    }

    public string Restore(string name)
    {
        var dest = RepoPath(name);
        if (Directory.Exists(dest)) throw new ConflictException($"A repository folder named '{name}' already exists.");
        var src = Directory.Exists(_o.ArchiveRoot)
            ? Directory.GetDirectories(_o.ArchiveRoot, name + ".*").OrderByDescending(d => d).FirstOrDefault()
            : null;
        if (src is null || !LooksLikeRepo(src)) throw new NotFoundException($"No archived copy of '{name}' found in {_o.ArchiveRoot}.");
        Directory.Move(src, dest);
        return src;
    }

    private long Size(string path)
    {
        if (_sizeCache.TryGetValue(path, out var c) && DateTime.UtcNow - c.At < TimeSpan.FromMinutes(10)) return c.Size;
        long total = 0;
        try
        {
            total = new DirectoryInfo(path).EnumerateFiles("*", SearchOption.AllDirectories).Sum(f => f.Length);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Could not size {Path}", path);
        }
        _sizeCache[path] = (DateTime.UtcNow, total);
        return total;
    }
}
