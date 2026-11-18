using System.IO.Compression;
using Dapper;
using Microsoft.Extensions.Options;
using SvnAdmin.Data;

namespace SvnAdmin.Services;

public sealed record BackupSettings(bool Enabled, string DailyTime, int ConfigSnapshotsToKeep);

public sealed record SnapshotFile(string Name, long SizeBytes);

public sealed record Snapshot(string Id, DateTime CreatedUtc, long SizeBytes, List<SnapshotFile> Files);

/// <summary>
/// Config backups: a snapshot of the Apache passwd file, the authz file and the SvnAdmin database
/// (taken with SQLite's VACUUM INTO, so it's consistent while the app is running).
/// Each snapshot is a folder BackupRoot/config/yyyyMMdd-HHmmss; the oldest are removed beyond the "keep" setting.
/// </summary>
public sealed class BackupService(Db db, ConfigSync sync, IOptions<SvnOptions> options, ILogger<BackupService> logger)
{
    private readonly SvnOptions _o = options.Value;
    private readonly SemaphoreSlim _running = new(1, 1);

    private string SnapshotRoot => Path.Combine(_o.BackupRoot, "config");

    public bool IsRunning => _running.CurrentCount == 0;

    public BackupSettings GetSettings()
    {
        using var conn = db.Open();
        return new BackupSettings(
            ConfigSync.GetSetting(conn, null, "backup.enabled") != "false", // on unless an admin turned it off
            ConfigSync.GetSetting(conn, null, "backup.time") ?? "02:00",
            int.TryParse(ConfigSync.GetSetting(conn, null, "backup.config_keep"), out var k) ? k : 30);
    }

    public void SaveSettings(BackupSettings s, Actor actor)
    {
        if (!TimeOnly.TryParseExact(s.DailyTime, "HH:mm", out _)) throw new AppException("Time must be HH:mm (24-hour), e.g. 02:00.");
        if (s.ConfigSnapshotsToKeep is < 1 or > 365) throw new AppException("Snapshots to keep must be between 1 and 365.");
        using var conn = db.Open();
        ConfigSync.SetSetting(conn, null, "backup.enabled", s.Enabled ? "true" : "false");
        ConfigSync.SetSetting(conn, null, "backup.time", s.DailyTime);
        ConfigSync.SetSetting(conn, null, "backup.config_keep", s.ConfigSnapshotsToKeep.ToString());
        Audit.Write(conn, null, actor, "backup.settings", "", $"Enabled: {s.Enabled}, time: {s.DailyTime}, keep: {s.ConfigSnapshotsToKeep}");
    }

    /// <summary>Takes a snapshot now. Returns null if one is already being taken.</summary>
    public Snapshot? TryRun(string trigger, Actor actor)
    {
        if (string.IsNullOrWhiteSpace(_o.BackupRoot)) throw new AppException("Svn:BackupRoot is not set.");
        if (!_running.Wait(0)) return null;
        long runId = 0;
        try
        {
            var id = DateTime.Now.ToString(NameFormat); // e.g. 2026-11-13_21-20-53 (server time)
            var dir = Path.Combine(SnapshotRoot, id);
            for (var n = 2; Directory.Exists(dir); n++) dir = Path.Combine(SnapshotRoot, $"{id}-{n}");

            using (var conn = db.Open())
                runId = conn.ExecuteScalar<long>("""
                    INSERT INTO backup_runs (repo_name, kind, trigger, started_at, status, target_path)
                    VALUES ('config', 'config', @trigger, @now, 'running', @dir) RETURNING id
                    """, new { trigger, now = Clock.Now(), dir });

            Directory.CreateDirectory(dir);
            foreach (var f in new[] { _o.PasswdFile, _o.AuthzFile }.Where(File.Exists))
                File.Copy(f, Path.Combine(dir, Path.GetFileName(f)));
            using (var conn = db.Open())
                conn.Execute("VACUUM INTO @path", new { path = Path.Combine(dir, "svnadmin.db") });

            var snapshot = Read(new DirectoryInfo(dir));
            Prune();
            Finish(runId, "ok", $"{snapshot.Files.Count} files, {snapshot.SizeBytes:N0} bytes");
            using (var conn = db.Open())
                Audit.Write(conn, null, actor, "backup.config", Path.GetFileName(dir), $"{trigger}: {string.Join(", ", snapshot.Files.Select(f => f.Name))}");
            return snapshot;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or Microsoft.Data.Sqlite.SqliteException)
        {
            logger.LogError(ex, "Config backup failed");
            if (runId != 0) Finish(runId, "failed", ex.Message);
            using (var conn = db.Open()) Audit.Write(conn, null, actor, "backup.failed", "config", ex.Message);
            throw new AppException("The config backup failed: " + ex.Message);
        }
        finally
        {
            _running.Release();
        }
    }

    /// <summary>Snapshots on disk, newest first.</summary>
    public List<Snapshot> List()
    {
        if (!Directory.Exists(SnapshotRoot)) return [];
        return new DirectoryInfo(SnapshotRoot).GetDirectories().Select(Read)
            .OrderByDescending(s => s.CreatedUtc).ThenByDescending(s => s.Id, StringComparer.Ordinal).ToList();
    }

    public sealed record RestoreResult(string SafetySnapshot, List<string> Warnings);

    /// <summary>
    /// Restores SVN access (passwords, enabled accounts, groups, folder permissions) from a snapshot.
    /// A fresh snapshot is taken first, so the restore itself can be undone by restoring that one.
    /// </summary>
    public RestoreResult Restore(string id, Actor actor)
    {
        var dir = SnapshotDir(id);
        var passwd = Path.Combine(dir, Path.GetFileName(_o.PasswdFile));
        var authz = Path.Combine(dir, Path.GetFileName(_o.AuthzFile));
        if (!File.Exists(passwd) || !File.Exists(authz))
            throw new AppException("This snapshot doesn't contain both the passwd and authz files, so it can't be restored.");

        // Read first: the safety snapshot may prune old snapshots, possibly this one.
        var passwdText = File.ReadAllText(passwd);
        var authzText = File.ReadAllText(authz);
        var safety = TryRun("before-restore", actor) ?? throw new ConflictException("A config backup is being taken. Try again in a moment.");
        var warnings = sync.RestoreAccess(actor, passwdText, authzText, id);
        logger.LogWarning("Config snapshot {Id} restored by {Actor}; safety snapshot {Safety}", id, actor.Name, safety.Id);
        return new RestoreResult(safety.Id, warnings);
    }

    /// <summary>Deletes one snapshot. The last remaining snapshot can't be deleted.</summary>
    public void Delete(string id, Actor actor)
    {
        var dir = SnapshotDir(id);
        if (!_running.Wait(0)) throw new ConflictException("A config backup is being taken. Try again in a moment.");
        try
        {
            if (List().Count <= 1) throw new AppException("This is the only snapshot, so it can't be deleted. Take a new one first.");
            var snap = Read(new DirectoryInfo(dir));
            try { Directory.Delete(dir, recursive: true); }
            catch (IOException ex) { throw new AppException("The snapshot couldn't be deleted: " + ex.Message); }
            using var conn = db.Open();
            Audit.Write(conn, null, actor, "backup.delete", id, $"{snap.Files.Count} files, {snap.SizeBytes:N0} bytes");
        }
        finally
        {
            _running.Release();
        }
    }

    private string SnapshotDir(string id)
    {
        if (string.IsNullOrWhiteSpace(id) || id.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || id.Contains(".."))
            throw new AppException("Invalid snapshot.");
        var dir = Path.Combine(SnapshotRoot, id);
        if (!Directory.Exists(dir)) throw new NotFoundException("Snapshot not found.");
        return dir;
    }

    /// <summary>A zip of one snapshot, for download.</summary>
    public (byte[] Zip, string FileName) Zip(string id)
    {
        var dir = SnapshotDir(id);
        using var ms = new MemoryStream();
        using (var zip = new ZipArchive(ms, ZipArchiveMode.Create, leaveOpen: true))
            foreach (var f in Directory.GetFiles(dir))
                zip.CreateEntryFromFile(f, Path.GetFileName(f), CompressionLevel.Optimal);
        return (ms.ToArray(), $"svnadmin-config-{id}.zip");
    }

    /// <summary>Snapshot folder names: the date and time they were taken (server time).</summary>
    private const string NameFormat = "yyyy-MM-dd_HH-mm-ss";
    private static readonly string[] KnownFormats = [NameFormat, "yyyyMMdd-HHmmss"]; // the second is the earlier naming

    private static Snapshot Read(DirectoryInfo d)
    {
        var files = d.GetFiles().OrderBy(f => f.Name).Select(f => new SnapshotFile(f.Name, f.Length)).ToList();
        return new Snapshot(d.Name, TakenUtc(d), files.Sum(f => f.SizeBytes), files);
    }

    /// <summary>When the snapshot was taken: from its name ("-2" style suffixes ignored), else the folder's creation time.</summary>
    private static DateTime TakenUtc(DirectoryInfo d)
    {
        var name = d.Name;
        foreach (var format in KnownFormats)
            if (name.Length >= format.Length && DateTime.TryParseExact(name[..format.Length], format, System.Globalization.CultureInfo.InvariantCulture,
                    System.Globalization.DateTimeStyles.AssumeLocal, out var local))
                return local.ToUniversalTime();
        return d.CreationTimeUtc;
    }

    private void Prune()
    {
        var keep = GetSettings().ConfigSnapshotsToKeep;
        foreach (var old in new DirectoryInfo(SnapshotRoot).GetDirectories().OrderByDescending(TakenUtc).ThenByDescending(d => d.Name, StringComparer.Ordinal).Skip(keep))
        {
            try { old.Delete(true); } catch (IOException ex) { logger.LogWarning(ex, "Could not remove old snapshot {Dir}", old.FullName); }
        }
    }

    private void Finish(long runId, string status, string message)
    {
        using var conn = db.Open();
        conn.Execute("UPDATE backup_runs SET status = @status, message = @message, finished_at = @now WHERE id = @runId",
            new { status, message, now = Clock.Now(), runId });
    }
}

/// <summary>Checks once a minute whether the daily config backup is due.</summary>
public sealed class BackupScheduler(BackupService backups, Db db, ILogger<BackupScheduler> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMinutes(1));
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            try
            {
                var s = backups.GetSettings();
                if (!s.Enabled) continue;
                var now = DateTime.Now; // server local time, which is what admins set
                if (TimeOnly.FromDateTime(now) < TimeOnly.ParseExact(s.DailyTime, "HH:mm")) continue;

                var today = now.ToString("yyyy-MM-dd");
                using var conn = db.Open();
                if (ConfigSync.GetSetting(conn, null, "backup.last_scheduled") == today) continue;
                ConfigSync.SetSetting(conn, null, "backup.last_scheduled", today);
                backups.TryRun("schedule", Actor.System);
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Backup scheduler error");
            }
        }
    }
}
