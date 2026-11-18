using System.Diagnostics;
using System.Text;
using System.Xml.Linq;
using Microsoft.Extensions.Options;

namespace SvnAdmin.Svn;

public sealed record CliResult(int ExitCode, string StdOut, string StdErr)
{
    public bool Ok => ExitCode == 0;
}

public sealed record LogEntry(string Repo, long Revision, string Author, DateTime? Date, string Message, List<LogPath> Paths);
public sealed record LogPath(string Action, string Path, string Kind);
public sealed record TreeEntry(string Name, string Kind);
public sealed record SvnLock(string Repo, string Path, string Owner, DateTime? CreatedAt, string Expires, string Comment);

/// <summary>
/// Runs the Subversion command-line tools. Arguments are always passed as a list
/// (never through a shell), so user input cannot inject extra commands.
/// </summary>
public sealed class SvnCli(IOptions<SvnOptions> options, ILogger<SvnCli> logger)
{
    private readonly SvnOptions _o = options.Value;

    public string ToolPath(string tool)
    {
        if (string.IsNullOrWhiteSpace(_o.SvnBinDir)) return tool;
        return Path.Combine(_o.SvnBinDir, tool + (OperatingSystem.IsWindows() ? ".exe" : ""));
    }

    public bool ToolExists(string tool)
    {
        if (!string.IsNullOrWhiteSpace(_o.SvnBinDir)) return File.Exists(ToolPath(tool));
        var exe = tool + (OperatingSystem.IsWindows() ? ".exe" : "");
        return (Environment.GetEnvironmentVariable("PATH") ?? "")
            .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
            .Any(dir => File.Exists(Path.Combine(dir, exe)));
    }

    public async Task<CliResult> RunAsync(string tool, IEnumerable<string> args, TimeSpan? timeout = null, CancellationToken ct = default)
    {
        var psi = new ProcessStartInfo(ToolPath(tool))
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        foreach (var a in args) psi.ArgumentList.Add(a);
        // Keep output in English and UTF-8 so it can be parsed reliably.
        psi.Environment["LC_ALL"] = "C";
        psi.Environment["LANG"] = "C";

        using var proc = new Process { StartInfo = psi };
        try
        {
            proc.Start();
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Could not start {Tool}", psi.FileName);
            throw new AppException($"Could not run {tool}. Check Svn:SvnBinDir in appsettings.json.");
        }

        var stdout = proc.StandardOutput.ReadToEndAsync(ct);
        var stderr = proc.StandardError.ReadToEndAsync(ct);
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(timeout ?? TimeSpan.FromSeconds(60));
        try
        {
            await proc.WaitForExitAsync(cts.Token);
        }
        catch (OperationCanceledException)
        {
            try { proc.Kill(entireProcessTree: true); } catch { /* already gone */ }
            throw new AppException($"{tool} timed out.");
        }
        var result = new CliResult(proc.ExitCode, await stdout, await stderr);
        if (!result.Ok)
            logger.LogWarning("{Tool} {Args} exited {Code}: {Err}", tool, string.Join(' ', psi.ArgumentList), result.ExitCode, result.StdErr.Trim());
        return result;
    }

    public static string FileUrl(string repoPath, string inner = "/")
    {
        var url = new Uri(Path.GetFullPath(repoPath)).AbsoluteUri.TrimEnd('/');
        if (inner != "/") url += string.Join('/', inner.Split('/').Select(Uri.EscapeDataString));
        return url;
    }

    public async Task<long?> YoungestAsync(string repoPath, CancellationToken ct = default)
    {
        var r = await RunAsync("svnlook", ["youngest", repoPath], ct: ct);
        return r.Ok && long.TryParse(r.StdOut.Trim(), out var rev) ? rev : null;
    }

    public async Task<List<LogEntry>> LogAsync(string repoName, string repoPath, int limit, bool verbose, CancellationToken ct = default)
    {
        var args = new List<string> { "log", "--xml", "--non-interactive", "-l", limit.ToString() };
        if (verbose) args.Add("-v");
        args.Add(FileUrl(repoPath));
        var r = await RunAsync("svn", args, TimeSpan.FromSeconds(60), ct);
        if (!r.Ok) return [];

        var xml = XDocument.Parse(r.StdOut);
        return xml.Root!.Elements("logentry").Select(e => new LogEntry(
            repoName,
            long.Parse(e.Attribute("revision")!.Value),
            e.Element("author")?.Value ?? "",
            DateTime.TryParse(e.Element("date")?.Value, null, System.Globalization.DateTimeStyles.AdjustToUniversal, out var d) ? d : null,
            e.Element("msg")?.Value ?? "",
            e.Element("paths")?.Elements("path").Select(p => new LogPath(
                p.Attribute("action")?.Value ?? "",
                p.Value,
                p.Attribute("kind")?.Value ?? "")).ToList() ?? []
        )).ToList();
    }

    /// <summary>Author and date of every revision in a range, without changed paths (fast).</summary>
    public async Task<List<(long Revision, string Author, DateTime? Date)>> AuthorsAsync(string repoPath, long from, long to, CancellationToken ct = default)
    {
        var r = await RunAsync("svn", ["log", "--xml", "-q", "--non-interactive", "-r", $"{from}:{to}", FileUrl(repoPath)], TimeSpan.FromMinutes(30), ct);
        if (!r.Ok) throw new AppException("svn log failed: " + r.StdErr.Trim());
        return XDocument.Parse(r.StdOut).Root!.Elements("logentry").Select(e => (
            long.Parse(e.Attribute("revision")!.Value),
            e.Element("author")?.Value ?? "",
            DateTime.TryParse(e.Element("date")?.Value, null, System.Globalization.DateTimeStyles.AdjustToUniversal, out var d) ? d : (DateTime?)null
        )).ToList();
    }

    public async Task<List<SvnLock>> LocksAsync(string repoName, string repoPath, CancellationToken ct = default)
    {
        var r = await RunAsync("svnadmin", ["lslocks", repoPath], ct: ct);
        if (!r.Ok) throw new AppException($"svnadmin lslocks failed for {repoName}: " + r.StdErr.Trim());
        return ParseLocks(repoName, r.StdOut);
    }

    public async Task<CliResult> RemoveLocksAsync(string repoPath, IEnumerable<string> paths, CancellationToken ct = default) =>
        await RunAsync("svnadmin", ["rmlocks", repoPath, .. paths], ct: ct);

    /// <summary>Parses "svnadmin lslocks" output (blocks of Path/UUID Token/Owner/Created/Expires/Comment).</summary>
    public static List<SvnLock> ParseLocks(string repoName, string output)
    {
        var locks = new List<SvnLock>();
        var lines = output.Replace("\r\n", "\n").Split('\n');
        for (var i = 0; i < lines.Length; i++)
        {
            if (!lines[i].StartsWith("Path: ")) continue;
            string path = lines[i][6..], owner = "", created = "", expires = "", comment = "";
            for (i++; i < lines.Length && lines[i].Length > 0; i++)
            {
                var l = lines[i];
                if (l.StartsWith("Owner: ")) owner = l[7..];
                else if (l.StartsWith("Created: ")) created = l[9..];
                else if (l.StartsWith("Expires: ")) expires = l[9..].Trim();
                else if (l.StartsWith("Comment (") && int.TryParse(new string(l[9..].TakeWhile(char.IsDigit).ToArray()), out var n))
                {
                    comment = string.Join("\n", lines.Skip(i + 1).Take(n));
                    i += n;
                }
            }
            locks.Add(new SvnLock(repoName, path, owner, ParseSvnDate(created), expires, comment.Trim()));
        }
        return locks;
    }

    /// <summary>"2026-11-13 14:00:00 +0530 (Fri, 13 Nov 2026)" → UTC.</summary>
    private static DateTime? ParseSvnDate(string s)
    {
        var cut = s.IndexOf(" (", StringComparison.Ordinal);
        if (cut > 0) s = s[..cut];
        return DateTimeOffset.TryParseExact(s, "yyyy-MM-dd HH:mm:ss zzz", System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.None, out var d) ? d.UtcDateTime : null;
    }

    public async Task<List<TreeEntry>> ListAsync(string repoPath, string inner, CancellationToken ct = default)
    {
        var r = await RunAsync("svn", ["list", "--xml", "--non-interactive", FileUrl(repoPath, inner)], ct: ct);
        if (!r.Ok) throw new AppException("Path not found in repository.");
        var xml = XDocument.Parse(r.StdOut);
        return xml.Descendants("entry")
            .Select(e => new TreeEntry(e.Element("name")!.Value, e.Attribute("kind")!.Value))
            .OrderBy(e => e.Kind == "dir" ? 0 : 1).ThenBy(e => e.Name, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }
}
