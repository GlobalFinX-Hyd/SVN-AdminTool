using SvnAdmin.Svn;

namespace SvnAdmin.Tests;

/// <summary>
/// Each case below was checked against a real svnserve 1.14 (the same authz engine Apache's mod_authz_svn uses)
/// before being written down here. If one fails, the access report no longer matches what SVN actually does.
/// </summary>
public class AccessEvaluatorTests
{
    private static readonly HashSet<string> UGroups = new(["g1", "g2"], StringComparer.OrdinalIgnoreCase); // u is in g1 and g2
    private static readonly HashSet<string> VGroups = new(["g1"], StringComparer.OrdinalIgnoreCase);       // v is only in g1

    private static AccessEvaluator Eval(string authz) => new(AuthzFile.Parse(authz).Rules);

    private const string Main = """
        [/]
        * = r
        [r1:/]
        @g1 = rw
        [r1:/other]
        @g1 = rw
        u =
        [/trunk]
        @g2 =
        [/trunk/deep]
        @g1 = r
        @g2 = rw
        """;

    [Fact]
    public void Union_within_a_section_explicit_none_does_not_cancel_a_group_grant()
        => Assert.Equal("rw", Eval(Main).Evaluate("u", UGroups, "r1", "/other").Access);

    [Fact]
    public void Deeper_all_repository_section_beats_shallower_repository_section()
        => Assert.Equal("", Eval(Main).Evaluate("u", UGroups, "r1", "/trunk").Access);

    [Fact]
    public void Sections_that_do_not_mention_the_user_are_skipped()
        => Assert.Equal("rw", Eval(Main).Evaluate("v", VGroups, "r1", "/trunk").Access);

    [Fact]
    public void Union_of_two_groups_at_the_same_path()
    {
        Assert.Equal("rw", Eval(Main).Evaluate("u", UGroups, "r1", "/trunk/deep").Access);
        Assert.Equal("r", Eval(Main).Evaluate("v", VGroups, "r1", "/trunk/deep").Access);
    }

    [Fact]
    public void Repository_section_overrides_all_repository_section_on_the_same_path()
    {
        var e = Eval("""
            [/other]
            u = rw
            v =
            [r1:/other]
            u =
            v = r
            """);
        Assert.Equal("", e.Evaluate("u", UGroups, "r1", "/other").Access);
        Assert.Equal("r", e.Evaluate("v", VGroups, "r1", "/other").Access);
    }

    [Fact]
    public void Inherits_from_parent_and_reports_which_section_decided()
    {
        var r = Eval(Main).Evaluate("v", VGroups, "r1", "/other/sub/folder");
        Assert.Equal("rw", r.Access);
        Assert.Equal("r1", r.Repo);
        Assert.Equal("/other", r.Path);
    }

    [Fact]
    public void Other_repositories_fall_back_to_global_rules_and_no_rule_means_no_access()
    {
        Assert.Equal("r", Eval(Main).Evaluate("v", VGroups, "r2", "/").Access);
        Assert.Equal("", Eval("[r1:/]\n@g1 = rw\n").Evaluate("v", VGroups, "r2", "/").Access);
    }

    [Fact]
    public void Anonymous_rules_never_apply_to_signed_in_users()
        => Assert.Equal("", Eval("[/]\n$anonymous = rw\n").Evaluate("v", VGroups, "r1", "/").Access);

    [Fact]
    public void HasDeeperRules_flags_folders_with_different_rules()
    {
        var e = Eval(Main);
        Assert.True(e.HasDeeperRules("u", UGroups, "r1", "/"));
        Assert.False(e.HasDeeperRules("v", VGroups, "r1", "/other"));
    }
}
