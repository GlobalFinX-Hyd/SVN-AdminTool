using System.Reflection;
using Dapper;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Options;

namespace SvnAdmin.Data;

/// <summary>Opens SQLite connections and applies the embedded SQL migrations.</summary>
public sealed class Db
{
    private readonly string _connectionString;

    public Db(IOptions<SvnOptions> options, IHostEnvironment env)
    {
        var path = options.Value.DatabasePath;
        if (!Path.IsPathRooted(path)) path = Path.Combine(env.ContentRootPath, path);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        FilePath = path;
        _connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = path,
            Mode = SqliteOpenMode.ReadWriteCreate,
            Cache = SqliteCacheMode.Private,
            ForeignKeys = true,
            DefaultTimeout = 30,
        }.ToString();
    }

    public string FilePath { get; }

    public SqliteConnection Open()
    {
        var conn = new SqliteConnection(_connectionString);
        conn.Open();
        conn.Execute("PRAGMA busy_timeout = 10000;");
        return conn;
    }

    public void Migrate()
    {
        DefaultTypeMap.MatchNamesWithUnderscores = true;

        using var conn = Open();
        conn.Execute("PRAGMA journal_mode = WAL;");
        conn.Execute("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);");
        var applied = conn.Query<long>("SELECT version FROM schema_version").ToHashSet();

        var asm = Assembly.GetExecutingAssembly();
        var scripts = asm.GetManifestResourceNames()
            .Where(n => n.Contains(".Data.Migrations.") && n.EndsWith(".sql"))
            .Select(n => (Name: n, Version: int.Parse(n.Split(".Data.Migrations.")[1].Split('_')[0])))
            .OrderBy(s => s.Version);

        foreach (var (name, version) in scripts)
        {
            if (applied.Contains(version)) continue;
            using var stream = asm.GetManifestResourceStream(name)!;
            using var reader = new StreamReader(stream);
            var sql = reader.ReadToEnd();
            using var tx = conn.BeginTransaction();
            conn.Execute(sql, transaction: tx);
            conn.Execute("INSERT INTO schema_version (version, applied_at) VALUES (@version, @at)",
                new { version, at = Clock.Now() }, tx);
            tx.Commit();
        }
    }
}

public static class Clock
{
    /// <summary>All timestamps are stored as ISO-8601 UTC text.</summary>
    public static string Now() => DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ");
}
