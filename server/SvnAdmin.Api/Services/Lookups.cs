using System.Data;
using System.Text.RegularExpressions;
using Dapper;

namespace SvnAdmin.Services;

/// <summary>Read helpers and validation rules shared by the endpoints.</summary>
public static partial class Lookups
{
    [GeneratedRegex("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")]
    private static partial Regex NamePattern();

    public static void ValidateName(string? name, string what)
    {
        if (string.IsNullOrWhiteSpace(name) || !NamePattern().IsMatch(name))
            throw new AppException($"{what} must be 1–64 characters: letters, numbers, dot, underscore or hyphen, starting with a letter or number.");
    }

    public static void ValidatePassword(string? password, string username, int minLength)
    {
        if (string.IsNullOrEmpty(password) || password.Length < minLength)
            throw new AppException($"Password must be at least {minLength} characters.");
        if (password.Length > 128)
            throw new AppException("Password must be 128 characters or fewer.");
        if (password.Contains(username, StringComparison.OrdinalIgnoreCase))
            throw new AppException("Password must not contain the username.");
        if (password.Contains(':') || password.Any(char.IsControl))
            throw new AppException("Password must not contain ':' or control characters.");
    }

    public static long UserId(IDbConnection conn, IDbTransaction? tx, string username) =>
        conn.ExecuteScalar<long?>("SELECT id FROM users WHERE username = @username", new { username }, tx)
        ?? throw new NotFoundException($"User '{username}' not found.");

    public static long GroupId(IDbConnection conn, IDbTransaction? tx, string name) =>
        conn.ExecuteScalar<long?>("SELECT id FROM groups WHERE name = @name", new { name }, tx)
        ?? throw new NotFoundException($"Group '{name}' not found.");

    /// <summary>Every group the user belongs to, directly or through nested groups.</summary>
    public static HashSet<string> EffectiveGroups(IDbConnection conn, IDbTransaction? tx, string username)
    {
        var direct = conn.Query<string>("""
            SELECT g.name FROM groups g
            JOIN group_user_members m ON m.group_id = g.id
            JOIN users u ON u.id = m.user_id
            WHERE u.username = @username
            """, new { username }, tx);
        var parentsOf = conn.Query<(string Child, string Parent)>("""
            SELECT c.name, p.name FROM group_group_members m
            JOIN groups c ON c.id = m.member_group_id
            JOIN groups p ON p.id = m.group_id
            """, transaction: tx).ToLookup(x => x.Child, x => x.Parent, StringComparer.OrdinalIgnoreCase);

        var result = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var stack = new Stack<string>(direct);
        while (stack.Count > 0)
        {
            var g = stack.Pop();
            if (!result.Add(g)) continue;
            foreach (var p in parentsOf[g]) stack.Push(p);
        }
        return result;
    }

    public static bool IsAdmin(IDbConnection conn, IDbTransaction? tx, string username, string adminGroup)
    {
        var enabled = conn.ExecuteScalar<long?>("SELECT is_enabled FROM users WHERE username = @username", new { username }, tx);
        return enabled == 1 && EffectiveGroups(conn, tx, username).Contains(adminGroup);
    }

    /// <summary>Call inside a change, after applying it, to stop admins locking everyone (or themselves) out.</summary>
    public static void EnsureAdminsRemain(IDbConnection conn, IDbTransaction tx, Actor actor, string adminGroup)
    {
        if (!IsAdmin(conn, tx, actor.Name, adminGroup))
            throw new AppException($"This change would remove your own admin access (membership of '{adminGroup}'). Ask another admin to make it.");
    }
}
