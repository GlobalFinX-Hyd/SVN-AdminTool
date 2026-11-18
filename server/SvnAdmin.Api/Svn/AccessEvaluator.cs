namespace SvnAdmin.Svn;

/// <summary>
/// Works out a user's effective access the way mod_authz_svn / svnserve (Subversion 1.10+) do.
/// Verified against svnserve 1.14:
///  1. Walk from the requested path up to "/".
///  2. At each level, look at the repository-specific section [repo:/path] first. If any rule there matches the
///     user, it decides, and the all-repository section [/path] at the same level is ignored completely.
///     Otherwise the [/path] section decides if any of its rules match.
///  3. The first level with a match wins. Within it, the user gets the union of every matching rule
///     (so "@devs = rw" plus "alice =" still gives alice rw).
///  4. No matching rule anywhere means no access.
/// </summary>
public sealed class AccessEvaluator
{
    private readonly Dictionary<(string? Repo, string Path), List<AuthzRule>> _sections;

    public AccessEvaluator(IEnumerable<AuthzRule> rules)
    {
        _sections = rules
            .GroupBy(r => (Repo: r.Repo?.ToLowerInvariant(), r.Path))
            .ToDictionary(g => g.Key, g => g.ToList());
    }

    public sealed record Result(string Access, string? Repo, string Path);

    /// <param name="groups">Every group the user is in, including through nested groups.</param>
    public Result Evaluate(string username, ISet<string> groups, string repo, string path)
    {
        path = AuthzFile.NormalizePath(path);
        var key = repo.ToLowerInvariant();
        for (var p = path; ; p = Parent(p))
        {
            if (Match(username, groups, (key, p)) is { } repoAccess) return new Result(repoAccess, repo, p);
            if (Match(username, groups, (null, p)) is { } globalAccess) return new Result(globalAccess, null, p);
            if (p == "/") return new Result("", null, "/");
        }
    }

    /// <summary>True if any section below this path (in this repo, or in all repos) mentions the user, so sub-folders may differ.</summary>
    public bool HasDeeperRules(string username, ISet<string> groups, string repo, string path)
    {
        path = AuthzFile.NormalizePath(path);
        var prefix = path == "/" ? "/" : path + "/";
        var key = repo.ToLowerInvariant();
        return _sections.Any(s =>
            (s.Key.Repo == key || s.Key.Repo is null) &&
            s.Key.Path != path && s.Key.Path.StartsWith(prefix, StringComparison.Ordinal) &&
            s.Value.Any(r => Applies(r, username, groups)));
    }

    private string? Match(string username, ISet<string> groups, (string?, string) section)
    {
        if (!_sections.TryGetValue(section, out var rules)) return null;
        string? best = null;
        foreach (var r in rules.Where(r => Applies(r, username, groups)))
            best = Max(best, r.Access);
        return best;
    }

    private static bool Applies(AuthzRule r, string username, ISet<string> groups) => r.PrincipalType switch
    {
        "user" => r.PrincipalName.Equals(username, StringComparison.OrdinalIgnoreCase),
        "group" => groups.Contains(r.PrincipalName),
        "all" or "authenticated" => true,
        _ => false, // $anonymous never applies to a signed-in user
    };

    private static string Max(string? a, string b) =>
        a == "rw" || b == "rw" ? "rw" : a == "r" || b == "r" ? "r" : "";

    private static string Parent(string p)
    {
        var i = p.LastIndexOf('/');
        return i <= 0 ? "/" : p[..i];
    }
}
