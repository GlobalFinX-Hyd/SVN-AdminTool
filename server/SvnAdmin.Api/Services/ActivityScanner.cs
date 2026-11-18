using Dapper;
using SvnAdmin.Data;
using SvnAdmin.Svn;

namespace SvnAdmin.Services;

/// <summary>
/// Keeps "last commit per author" up to date for the inactive-users report.
/// Reads only new revisions each time ("svn log -q -r last+1:HEAD"), so after the first full pass it's cheap.
/// Runs at start-up, then hourly, and on demand.
/// </summary>
public sealed class ActivityScanner(Db db, SvnCli svn, RepoService repos, ILogger<ActivityScanner> logger) : BackgroundService
{
    private readonly SemaphoreSlim _gate = new(1, 1);

    public DateTime? LastRunUtc { get; private set; }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await Task.Delay(TimeSpan.FromSeconds(20), stoppingToken); // let start-up finish first
        using var timer = new PeriodicTimer(TimeSpan.FromHours(1));
        do
        {
            try { await ScanAsync(stoppingToken); }
            catch (Exception ex) when (ex is not OperationCanceledException) { logger.LogError(ex, "Activity scan failed"); }
        } while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    public async Task ScanAsync(CancellationToken ct)
    {
        if (!await _gate.WaitAsync(0, ct)) return; // already running
        try
        {
            var list = await repos.ListAsync(includeDetails: false, ct);
            foreach (var r in list.Where(r => !r.IsArchived && !r.MissingOnDisk))
            {
                var path = repos.RepoPath(r.Name);
                var head = await svn.YoungestAsync(path, ct);
                if (head is null) continue;
                long last;
                using (var conn = db.Open())
                    last = conn.ExecuteScalar<long?>("SELECT last_revision FROM repo_scan WHERE repo_name = @Name", new { r.Name }) ?? 0;
                if (head <= last) continue;

                List<(long Revision, string Author, DateTime? Date)> entries;
                try
                {
                    entries = await ReadRangeAsync(r.Name, path, last + 1, head.Value, ct);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    // One unreadable repository must not stop the others.
                    logger.LogWarning(ex, "Skipping {Repo} in this activity scan", r.Name);
                    continue;
                }
                using var c = db.Open();
                using var tx = c.BeginTransaction();
                foreach (var g in entries.Where(e => e.Author != "" && e.Date is not null).GroupBy(e => e.Author, StringComparer.OrdinalIgnoreCase))
                {
                    var latest = g.Max(e => e.Date!.Value).ToString("yyyy-MM-ddTHH:mm:ss.fffZ");
                    c.Execute("""
                        INSERT INTO author_activity (username, last_commit_at, last_repo, commit_count) VALUES (@u, @latest, @repo, @n)
                        ON CONFLICT (username) DO UPDATE SET
                          commit_count = commit_count + excluded.commit_count,
                          last_repo = CASE WHEN excluded.last_commit_at > last_commit_at THEN excluded.last_repo ELSE last_repo END,
                          last_commit_at = MAX(last_commit_at, excluded.last_commit_at)
                        """, new { u = g.Key, latest, repo = r.Name, n = g.Count() }, tx);
                }
                c.Execute("""
                    INSERT INTO repo_scan (repo_name, last_revision, scanned_at) VALUES (@Name, @head, @now)
                    ON CONFLICT (repo_name) DO UPDATE SET last_revision = excluded.last_revision, scanned_at = excluded.scanned_at
                    """, new { r.Name, head, now = Clock.Now() }, tx);
                tx.Commit();
                logger.LogInformation("Scanned {Repo} r{From}-r{To}", r.Name, last + 1, head);
            }
            LastRunUtc = DateTime.UtcNow;
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>
    /// Reads authors for a revision range. If svn log fails (for example a revision whose revprops file is missing),
    /// the range is split in half and retried, so only the unreadable revisions are skipped.
    /// </summary>
    private async Task<List<(long Revision, string Author, DateTime? Date)>> ReadRangeAsync(string repo, string path, long from, long to, CancellationToken ct)
    {
        try
        {
            return await svn.AuthorsAsync(path, from, to, ct);
        }
        catch (AppException) when (from < to)
        {
            var mid = from + (to - from) / 2;
            var left = await ReadRangeAsync(repo, path, from, mid, ct);
            var right = await ReadRangeAsync(repo, path, mid + 1, to, ct);
            return [.. left, .. right];
        }
        catch (AppException ex)
        {
            logger.LogWarning("Revision r{Rev} in {Repo} can't be read and was skipped: {Error}", from, repo, ex.Message);
            return [];
        }
    }
}
