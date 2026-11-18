using System.Security.Cryptography;

namespace SvnAdmin.Security;

/// <summary>Random passwords without look-alike characters (same rules as the browser's generator).</summary>
public static class PasswordGenerator
{
    private static readonly string[] Sets = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!#%+=?@^_-"];

    public static string New(int length = 16)
    {
        var all = string.Concat(Sets);
        var chars = Sets.Select(s => s[RandomNumberGenerator.GetInt32(s.Length)]).ToList();
        while (chars.Count < length) chars.Add(all[RandomNumberGenerator.GetInt32(all.Length)]);
        for (var i = chars.Count - 1; i > 0; i--)
        {
            var j = RandomNumberGenerator.GetInt32(i + 1);
            (chars[i], chars[j]) = (chars[j], chars[i]);
        }
        return new string(chars.ToArray());
    }
}
