using System.Security.Cryptography;
using System.Text;

namespace SvnAdmin.Security;

/// <summary>
/// Creates and checks password hashes in the formats Apache's htpasswd file accepts.
/// New hashes are always bcrypt ($2y$), the same as "htpasswd -B".
/// Older APR1-MD5 ($apr1$) and {SHA} entries can still be verified so existing admins can sign in.
/// </summary>
public static class HtpasswdHash
{
    private const int BcryptCost = 12;

    public static string Create(string password)
    {
        // 'y' gives the $2y$ prefix that Apache's htpasswd -B writes.
        var salt = BCrypt.Net.BCrypt.GenerateSalt(BcryptCost, 'y');
        return BCrypt.Net.BCrypt.HashPassword(password, salt);
    }

    public static bool Verify(string password, string hash)
    {
        if (string.IsNullOrEmpty(hash)) return false;
        try
        {
            if (hash.StartsWith("$2y$") || hash.StartsWith("$2a$") || hash.StartsWith("$2b$"))
                return BCrypt.Net.BCrypt.Verify(password, hash);
            if (hash.StartsWith("$apr1$"))
                return FixedEquals(Apr1(password, hash.Split('$')[2]), hash);
            if (hash.StartsWith("{SHA}"))
                return FixedEquals("{SHA}" + Convert.ToBase64String(SHA1.HashData(Encoding.UTF8.GetBytes(password))), hash);
        }
        catch (Exception)
        {
            return false;
        }
        // crypt() and plain-text entries are not supported for admin sign-in.
        return false;
    }

    public static bool IsWeakFormat(string hash) => !hash.StartsWith("$2");

    private static bool FixedEquals(string a, string b) =>
        CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(a), Encoding.ASCII.GetBytes(b));

    // APR1 variant of md5-crypt, as implemented by Apache apr_md5_encode.
    private static string Apr1(string password, string salt)
    {
        const string magic = "$apr1$";
        if (salt.Length > 8) salt = salt[..8];
        var pw = Encoding.UTF8.GetBytes(password);
        var sb = Encoding.UTF8.GetBytes(salt);

        var alt = MD5.HashData([.. pw, .. sb, .. pw]);
        var ctx = new List<byte>();
        ctx.AddRange(pw);
        ctx.AddRange(Encoding.ASCII.GetBytes(magic));
        ctx.AddRange(sb);
        for (var len = pw.Length; len > 0; len -= 16)
            ctx.AddRange(alt.Take(Math.Min(16, len)));
        for (var i = pw.Length; i != 0; i >>= 1)
            ctx.Add((i & 1) != 0 ? (byte)0 : (pw.Length > 0 ? pw[0] : (byte)0));

        var final = MD5.HashData(ctx.ToArray());
        for (var i = 0; i < 1000; i++)
        {
            var round = new List<byte>();
            if ((i & 1) != 0) round.AddRange(pw); else round.AddRange(final);
            if (i % 3 != 0) round.AddRange(sb);
            if (i % 7 != 0) round.AddRange(pw);
            if ((i & 1) != 0) round.AddRange(final); else round.AddRange(pw);
            final = MD5.HashData(round.ToArray());
        }

        const string itoa64 = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
        var output = new StringBuilder();
        void To64(int v, int n) { while (n-- > 0) { output.Append(itoa64[v & 0x3f]); v >>= 6; } }
        To64((final[0] << 16) | (final[6] << 8) | final[12], 4);
        To64((final[1] << 16) | (final[7] << 8) | final[13], 4);
        To64((final[2] << 16) | (final[8] << 8) | final[14], 4);
        To64((final[3] << 16) | (final[9] << 8) | final[15], 4);
        To64((final[4] << 16) | (final[10] << 8) | final[5], 4);
        To64(final[11], 2);
        return magic + salt + "$" + output;
    }
}
