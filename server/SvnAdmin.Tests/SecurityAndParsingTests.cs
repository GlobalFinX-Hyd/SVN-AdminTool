using OtpNet;
using SvnAdmin.Endpoints;
using SvnAdmin.Security;
using SvnAdmin.Services;
using SvnAdmin.Svn;

namespace SvnAdmin.Tests;

public class HtpasswdHashTests
{
    [Fact]
    public void New_hashes_are_bcrypt_2y_like_htpasswd_B()
    {
        var h = HtpasswdHash.Create("Secret#123456");
        Assert.StartsWith("$2y$12$", h);
        Assert.True(HtpasswdHash.Verify("Secret#123456", h));
        Assert.False(HtpasswdHash.Verify("secret#123456", h));
    }

    [Fact]
    public void Verifies_apr1_md5_produced_by_openssl()
    {
        // openssl passwd -apr1 -salt Xy12AbCd 'DevAdmin#2026'
        const string hash = "$apr1$Xy12AbCd$NQ42w/7WcJh.Ls8oxYSfQ1";
        Assert.True(HtpasswdHash.Verify("DevAdmin#2026", hash));
        Assert.False(HtpasswdHash.Verify("DevAdmin#2027", hash));
        Assert.True(HtpasswdHash.IsWeakFormat(hash));
    }

    [Fact]
    public void Verifies_sha1()
    {
        // printf 'DevUser#2026' | openssl dgst -sha1 -binary | base64
        Assert.True(HtpasswdHash.Verify("DevUser#2026", "{SHA}vHWMhsGpnkNFd/EMyskKzhFAxck="));
    }

    [Theory]
    [InlineData("")]
    [InlineData("plaintext")]
    [InlineData("$apr1$broken")]
    public void Unknown_or_broken_formats_never_verify(string hash) => Assert.False(HtpasswdHash.Verify("plaintext", hash));
}

public class ValidationTests
{
    [Theory]
    [InlineData("bob")]
    [InlineData("first.last")]
    [InlineData("svc_build-01")]
    public void Accepts_valid_names(string name) => Lookups.ValidateName(name, "Username");

    [Theory]
    [InlineData("")]
    [InlineData("-bob")]
    [InlineData("@devs")]
    [InlineData("a b")]
    [InlineData("x:y")]
    [InlineData("../etc")]
    public void Rejects_invalid_names(string name) => Assert.Throws<AppException>(() => Lookups.ValidateName(name, "Username"));

    [Theory]
    [InlineData("short1!")]
    [InlineData("contains-bob-123")]
    [InlineData("has:colon-123456")]
    public void Rejects_weak_or_unusable_passwords(string pw) =>
        Assert.Throws<AppException>(() => Lookups.ValidatePassword(pw, "bob", 10));

    [Fact]
    public void Generated_passwords_pass_validation()
    {
        for (var i = 0; i < 50; i++) Lookups.ValidatePassword(PasswordGenerator.New(), "bob", 10);
    }
}

public class TotpTests
{
    [Fact]
    public void Accepts_current_and_adjacent_steps_only()
    {
        var secret = Base32Encoding.ToString(KeyGeneration.GenerateRandomKey(20));
        var totp = new Totp(Base32Encoding.ToBytes(secret));
        var now = DateTime.UtcNow;
        Assert.NotNull(Mfa.MatchStep(secret, totp.ComputeTotp(now)));
        Assert.NotNull(Mfa.MatchStep(secret, totp.ComputeTotp(now.AddSeconds(-30))));
        Assert.Null(Mfa.MatchStep(secret, totp.ComputeTotp(now.AddMinutes(-5))));
    }

    [Theory]
    [InlineData("")]
    [InlineData("12345")]
    [InlineData("abcdef")]
    public void Rejects_malformed_codes(string code) =>
        Assert.Null(Mfa.MatchStep(Base32Encoding.ToString(KeyGeneration.GenerateRandomKey(20)), code));

    [Fact]
    public void Spaces_in_codes_are_ignored()
    {
        var secret = Base32Encoding.ToString(KeyGeneration.GenerateRandomKey(20));
        var code = new Totp(Base32Encoding.ToBytes(secret)).ComputeTotp();
        Assert.NotNull(Mfa.MatchStep(secret, code[..3] + " " + code[3..]));
    }
}

public class LockParserTests
{
    [Fact]
    public void Parses_svnadmin_lslocks_output()
    {
        const string output = """
            Path: /trunk/spec.docx
            UUID Token: opaquelocktoken:61cb6a30
            Owner: dave
            Created: 2026-11-13 20:20:02 +0530 (Fri, 13 Nov 2026)
            Expires:
            Comment (2 lines):
            Editing spec
            for review

            Path: /trunk/plan.xlsx
            UUID Token: opaquelocktoken:fb953947
            Owner: carol
            Created: 2026-11-13 20:20:02 +0530 (Fri, 13 Nov 2026)
            Expires:
            Comment (0 lines):

            """;
        var locks = SvnCli.ParseLocks("projectA", output);
        Assert.Equal(2, locks.Count);
        Assert.Equal("/trunk/spec.docx", locks[0].Path);
        Assert.Equal("dave", locks[0].Owner);
        Assert.Equal("Editing spec\nfor review", locks[0].Comment);
        Assert.Equal(new DateTime(2026, 11, 13, 14, 50, 2, DateTimeKind.Utc), locks[0].CreatedAt);
        Assert.Equal("carol", locks[1].Owner);
        Assert.Equal("", locks[1].Comment);
    }

    [Fact]
    public void Empty_output_means_no_locks() => Assert.Empty(SvnCli.ParseLocks("r", ""));
}

public class CsvImportTests
{
    [Fact]
    public void Parses_header_quotes_and_group_lists()
    {
        var rows = ReportEndpoints.ParseCsv("username,full name,email,groups\r\nfrank,\"Frank, Jr\",frank@x.test,devs;qa\n# skipped\n\ngrace,Grace,,\n");
        Assert.Equal(2, rows.Count);
        Assert.Equal("Frank, Jr", rows[0].FullName);
        Assert.Equal(["devs", "qa"], rows[0].Groups);
        Assert.Equal("grace", rows[1].Username);
        Assert.Empty(rows[1].Groups);
    }
}
