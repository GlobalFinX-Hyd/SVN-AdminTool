using System.Text;

namespace SvnAdmin.Svn;

public sealed record PasswdEntry(string Username, string Hash);

/// <summary>Reads and writes Apache htpasswd files ("user:hash" per line).</summary>
public static class PasswdFile
{
    public static List<PasswdEntry> Parse(string text)
    {
        var list = new List<PasswdEntry>();
        foreach (var raw in text.Split('\n'))
        {
            var line = raw.TrimEnd('\r');
            if (line.Length == 0 || line.StartsWith('#')) continue;
            var idx = line.IndexOf(':');
            if (idx <= 0) continue;
            list.Add(new PasswdEntry(line[..idx].Trim(), line[(idx + 1)..].Trim()));
        }
        return list;
    }

    public static string Render(IEnumerable<PasswdEntry> entries)
    {
        var sb = new StringBuilder();
        foreach (var e in entries.OrderBy(e => e.Username, StringComparer.OrdinalIgnoreCase))
            sb.Append(e.Username).Append(':').Append(e.Hash).Append('\n');
        return sb.ToString();
    }
}

public sealed record AuthzGroup(string Name, List<string> Users, List<string> Groups);

/// <param name="Repo">Null for a section that applies to every repository ("[/path]").</param>
/// <param name="PrincipalType">user | group | all | authenticated | anonymous</param>
/// <param name="Access">"", "r" or "rw"</param>
public sealed record AuthzRule(string? Repo, string Path, string PrincipalType, string PrincipalName, string Access);

public sealed class AuthzDocument
{
    public List<AuthzGroup> Groups { get; } = [];
    public List<AuthzRule> Rules { get; } = [];
    public List<string> Warnings { get; } = [];
}

/// <summary>Reads and writes mod_authz_svn access files.</summary>
public static class AuthzFile
{
    public static AuthzDocument Parse(string text)
    {
        var doc = new AuthzDocument();
        string? section = null;
        string? repo = null;
        string path = "/";
        var lineNo = 0;

        foreach (var raw in text.Split('\n'))
        {
            lineNo++;
            var line = raw.Trim();
            if (line.Length == 0 || line.StartsWith('#')) continue;

            if (line.StartsWith('[') && line.EndsWith(']'))
            {
                section = line[1..^1].Trim();
                if (section is "groups" or "aliases") continue;
                var colon = section.IndexOf(':');
                if (colon > 0) { repo = section[..colon]; path = section[(colon + 1)..]; }
                else { repo = null; path = section; }
                if (!path.StartsWith('/'))
                {
                    doc.Warnings.Add($"Line {lineNo}: section [{section}] is not a path section; skipped.");
                    section = "__skip";
                }
                else
                {
                    path = NormalizePath(path);
                }
                continue;
            }

            var eq = line.IndexOf('=');
            if (eq <= 0 || section is null || section == "__skip")
            {
                if (section != "__skip") doc.Warnings.Add($"Line {lineNo}: could not read \"{line}\"; skipped.");
                continue;
            }
            var key = line[..eq].Trim();
            var value = line[(eq + 1)..].Trim();

            if (section == "aliases")
            {
                doc.Warnings.Add($"Line {lineNo}: alias \"{key}\" is not supported and was dropped.");
                continue;
            }

            if (section == "groups")
            {
                var g = new AuthzGroup(key, [], []);
                foreach (var m in value.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
                {
                    if (m.StartsWith('@')) g.Groups.Add(m[1..]);
                    else if (m.StartsWith('&')) doc.Warnings.Add($"Line {lineNo}: alias {m} in group {key} was dropped.");
                    else g.Users.Add(m);
                }
                doc.Groups.Add(g);
                continue;
            }

            var access = value.Replace(" ", "");
            if (access == "wr") access = "rw";
            if (access is not ("" or "r" or "rw"))
            {
                doc.Warnings.Add($"Line {lineNo}: access \"{value}\" for {key} is not r/rw/empty; skipped.");
                continue;
            }

            (string type, string name)? principal = key switch
            {
                "*" => ("all", ""),
                "$authenticated" => ("authenticated", ""),
                "$anonymous" => ("anonymous", ""),
                _ when key.StartsWith('@') => ("group", key[1..]),
                _ when key.StartsWith('~') || key.StartsWith('&') => null,
                _ => ("user", key),
            };
            if (principal is null)
            {
                doc.Warnings.Add($"Line {lineNo}: rule \"{key}\" uses inversion/aliases, which are not supported; skipped.");
                continue;
            }
            doc.Rules.Add(new AuthzRule(repo, path, principal.Value.type, principal.Value.name, access));
        }

        return doc;
    }

    public static string Render(IEnumerable<AuthzGroup> groups, IEnumerable<AuthzRule> rules, string header)
    {
        var sb = new StringBuilder();
        foreach (var h in header.Split('\n')) sb.Append("# ").Append(h).Append('\n');
        sb.Append('\n').Append("[groups]\n");
        foreach (var g in groups.OrderBy(g => g.Name, StringComparer.OrdinalIgnoreCase))
        {
            var members = g.Users.OrderBy(u => u, StringComparer.OrdinalIgnoreCase)
                .Concat(g.Groups.OrderBy(x => x, StringComparer.OrdinalIgnoreCase).Select(x => "@" + x));
            sb.Append(g.Name).Append(" = ").Append(string.Join(", ", members)).Append('\n');
        }

        var sections = rules
            .GroupBy(r => (r.Repo, r.Path))
            .OrderBy(s => s.Key.Repo is null ? 0 : 1)
            .ThenBy(s => s.Key.Repo, StringComparer.OrdinalIgnoreCase)
            .ThenBy(s => s.Key.Path, StringComparer.Ordinal);

        foreach (var s in sections)
        {
            sb.Append('\n').Append('[').Append(s.Key.Repo is null ? "" : s.Key.Repo + ":").Append(s.Key.Path).Append("]\n");
            foreach (var r in s.OrderBy(r => PrincipalOrder(r.PrincipalType)).ThenBy(r => r.PrincipalName, StringComparer.OrdinalIgnoreCase))
                sb.Append(PrincipalKey(r.PrincipalType, r.PrincipalName)).Append(" = ").Append(r.Access).Append('\n');
        }
        return sb.ToString();
    }

    public static string PrincipalKey(string type, string name) => type switch
    {
        "all" => "*",
        "authenticated" => "$authenticated",
        "anonymous" => "$anonymous",
        "group" => "@" + name,
        _ => name,
    };

    private static int PrincipalOrder(string type) => type switch
    {
        "all" => 0, "authenticated" => 1, "anonymous" => 2, "group" => 3, _ => 4,
    };

    /// <summary>"/a/b/" → "/a/b". Root stays "/".</summary>
    public static string NormalizePath(string path)
    {
        path = path.Trim().Replace('\\', '/');
        if (!path.StartsWith('/')) path = "/" + path;
        while (path.Contains("//")) path = path.Replace("//", "/");
        if (path.Length > 1) path = path.TrimEnd('/');
        return path;
    }
}
