using SvnAdmin.Svn;

namespace SvnAdmin.Tests;

/// <summary>The authz reader/writer: a bad file blocks all SVN access, so these matter most.</summary>
public class AuthzFileTests
{
    private const string Sample = """
        # comment
        [aliases]
        boss = bob

        [groups]
        devs = bob, carol
        leads = @devs, dave
        admins = alice

        [/]
        * =
        @admins = rw

        [projectA:/trunk/]
        @devs = rw
        dave = r
        $authenticated = r
        ~@devs = r
        """;

    [Fact]
    public void Parses_groups_including_nested()
    {
        var doc = AuthzFile.Parse(Sample);
        var leads = doc.Groups.Single(g => g.Name == "leads");
        Assert.Equal(["dave"], leads.Users);
        Assert.Equal(["devs"], leads.Groups);
        Assert.Equal(3, doc.Groups.Count);
    }

    [Fact]
    public void Parses_rules_and_normalises_trailing_slash()
    {
        var doc = AuthzFile.Parse(Sample);
        Assert.Contains(doc.Rules, r => r.Repo is null && r.Path == "/" && r.PrincipalType == "all" && r.Access == "");
        Assert.Contains(doc.Rules, r => r.Repo == "projectA" && r.Path == "/trunk" && r.PrincipalType == "group" && r.PrincipalName == "devs" && r.Access == "rw");
        Assert.Contains(doc.Rules, r => r.PrincipalType == "authenticated" && r.Access == "r");
    }

    [Fact]
    public void Warns_about_unsupported_aliases_and_inversion_instead_of_failing()
    {
        var doc = AuthzFile.Parse(Sample);
        Assert.Contains(doc.Warnings, w => w.Contains("alias"));
        Assert.Contains(doc.Warnings, w => w.Contains("~@devs"));
        Assert.DoesNotContain(doc.Rules, r => r.PrincipalName.StartsWith('~'));
    }

    [Fact]
    public void Render_then_parse_gives_the_same_groups_and_rules()
    {
        var doc = AuthzFile.Parse(Sample);
        var text = AuthzFile.Render(doc.Groups, doc.Rules, "header line");
        var again = AuthzFile.Parse(text);

        Assert.Empty(again.Warnings);
        Assert.Equal(doc.Groups.Select(GroupKey).Order(), again.Groups.Select(GroupKey).Order());
        Assert.Equal(doc.Rules.Select(RuleKey).Order(), again.Rules.Select(RuleKey).Order());

        static string GroupKey(AuthzGroup g) => $"{g.Name}={string.Join(",", g.Users.Order())}|{string.Join(",", g.Groups.Order())}";
        static string RuleKey(AuthzRule r) => $"{r.Repo}:{r.Path}:{r.PrincipalType}:{r.PrincipalName}={r.Access}";
    }

    [Fact]
    public void Render_writes_principals_in_authz_syntax()
    {
        var text = AuthzFile.Render(
            [new AuthzGroup("devs", ["bob"], [])],
            [
                new AuthzRule(null, "/", "all", "", ""),
                new AuthzRule("repo", "/x", "group", "devs", "rw"),
                new AuthzRule("repo", "/x", "authenticated", "", "r"),
                new AuthzRule("repo", "/x", "user", "carol", "r"),
            ], "h");
        Assert.Contains("[/]\n* = \n", text);
        Assert.Contains("[repo:/x]\n$authenticated = r\n@devs = rw\ncarol = r\n", text);
        Assert.StartsWith("# h\n", text);
    }

    [Theory]
    [InlineData("/", "/")]
    [InlineData("", "/")]
    [InlineData("trunk", "/trunk")]
    [InlineData("/trunk/", "/trunk")]
    [InlineData("//trunk//a/", "/trunk/a")]
    [InlineData("\\trunk\\a", "/trunk/a")]
    public void NormalizePath(string input, string expected) => Assert.Equal(expected, AuthzFile.NormalizePath(input));

    [Fact]
    public void Passwd_round_trip_keeps_hashes_and_sorts_users()
    {
        var entries = PasswdFile.Parse("zed:$2y$12$abc\r\n# comment\nalice:{SHA}xyz=\n\nbad-line\n");
        Assert.Equal(2, entries.Count);
        Assert.Equal("alice:{SHA}xyz=\nzed:$2y$12$abc\n", PasswdFile.Render(entries));
    }
}
