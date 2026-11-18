using System.Data;
using Dapper;
using Microsoft.Extensions.Options;
using SvnAdmin.Data;
using SvnAdmin.Services;

namespace SvnAdmin.Endpoints;

public static class GroupEndpoints
{
    public sealed record GroupDto(string Name, string Description, List<string> Users, List<string> Groups,
        List<string> MemberOf, int RuleCount, int EffectiveUserCount, bool IsAdminGroup);

    public sealed record SaveGroupRequest(string Name, string? Description, List<string>? Users, List<string>? Groups);

    public static void MapGroups(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/groups");

        g.MapGet("/", (Db db, IOptions<SvnOptions> opt) =>
        {
            using var conn = db.Open();
            return LoadGroups(conn, null, null, opt.Value.AdminGroup);
        });

        g.MapPost("/", (SaveGroupRequest req, HttpContext ctx, ConfigSync sync, Db db, IOptions<SvnOptions> opt) =>
        {
            var name = (req.Name ?? "").Trim();
            Lookups.ValidateName(name, "Group name");
            var actor = Actor.From(ctx);
            sync.Mutate(actor, (conn, tx) =>
            {
                if (conn.ExecuteScalar<long>("SELECT COUNT(*) FROM groups WHERE name = @name", new { name }, tx) > 0)
                    throw new ConflictException($"Group '{name}' already exists.");
                var id = conn.ExecuteScalar<long>("INSERT INTO groups (name, description, created_at) VALUES (@name, @d, @now) RETURNING id",
                    new { name, d = req.Description?.Trim() ?? "", now = Clock.Now() }, tx);
                SetMembers(conn, tx, id, req.Users ?? [], req.Groups ?? []);
                Audit.Write(conn, tx, actor, "group.create", name,
                    $"Users: {string.Join(", ", req.Users ?? [])}; groups: {string.Join(", ", req.Groups ?? [])}");
            });
            using var c = db.Open();
            return Results.Created($"/api/groups/{name}", LoadGroups(c, null, name, opt.Value.AdminGroup).Single());
        });

        g.MapPut("/{name}", (string name, SaveGroupRequest req, HttpContext ctx, ConfigSync sync, Db db, IOptions<SvnOptions> opt) =>
        {
            var newName = (req.Name ?? "").Trim();
            Lookups.ValidateName(newName, "Group name");
            var adminGroup = opt.Value.AdminGroup;
            if (name.Equals(adminGroup, StringComparison.OrdinalIgnoreCase) && !newName.Equals(adminGroup, StringComparison.OrdinalIgnoreCase))
                throw new AppException($"'{adminGroup}' is the SvnAdmin admin group and cannot be renamed. Change Svn:AdminGroup in appsettings.json first.");

            var actor = Actor.From(ctx);
            sync.Mutate(actor, (conn, tx) =>
            {
                var id = Lookups.GroupId(conn, tx, name);
                var before = LoadGroups(conn, tx, name, adminGroup).Single();
                if (!newName.Equals(name, StringComparison.Ordinal))
                {
                    if (!newName.Equals(name, StringComparison.OrdinalIgnoreCase) &&
                        conn.ExecuteScalar<long>("SELECT COUNT(*) FROM groups WHERE name = @newName", new { newName }, tx) > 0)
                        throw new ConflictException($"Group '{newName}' already exists.");
                    conn.Execute("UPDATE groups SET name = @newName WHERE id = @id", new { newName, id }, tx);
                    conn.Execute("UPDATE access_rules SET principal_name = @newName WHERE principal_type = 'group' AND principal_name = @name",
                        new { newName, name }, tx);
                }
                conn.Execute("UPDATE groups SET description = @d WHERE id = @id", new { d = req.Description?.Trim() ?? "", id }, tx);
                SetMembers(conn, tx, id, req.Users ?? [], req.Groups ?? []);
                Lookups.EnsureAdminsRemain(conn, tx, actor, adminGroup);

                var changes = new List<string>();
                if (newName != name) changes.Add($"renamed from {name}");
                Diff(changes, "users", before.Users, req.Users ?? []);
                Diff(changes, "groups", before.Groups, req.Groups ?? []);
                Audit.Write(conn, tx, actor, "group.update", newName, string.Join("; ", changes));
            });
            using var c = db.Open();
            return LoadGroups(c, null, newName, adminGroup).Single();
        });

        g.MapDelete("/{name}", (string name, HttpContext ctx, ConfigSync sync, IOptions<SvnOptions> opt) =>
        {
            if (name.Equals(opt.Value.AdminGroup, StringComparison.OrdinalIgnoreCase))
                throw new AppException($"'{name}' is the SvnAdmin admin group and cannot be deleted.");
            var actor = Actor.From(ctx);
            var removedRules = sync.Mutate(actor, (conn, tx) =>
            {
                var id = Lookups.GroupId(conn, tx, name);
                var rules = conn.Execute("DELETE FROM access_rules WHERE principal_type = 'group' AND principal_name = @name", new { name }, tx);
                conn.Execute("DELETE FROM groups WHERE id = @id", new { id }, tx);
                Audit.Write(conn, tx, actor, "group.delete", name, $"Removed {rules} permission(s) that used this group.");
                return rules;
            });
            return Results.Ok(new { removedRules });
        });
    }

    private static void Diff(List<string> changes, string what, List<string> before, List<string> after)
    {
        var added = after.Except(before, StringComparer.OrdinalIgnoreCase).ToList();
        var removed = before.Except(after, StringComparer.OrdinalIgnoreCase).ToList();
        if (added.Count > 0) changes.Add($"{what} added: {string.Join(", ", added)}");
        if (removed.Count > 0) changes.Add($"{what} removed: {string.Join(", ", removed)}");
    }

    private static void SetMembers(IDbConnection conn, IDbTransaction tx, long groupId, List<string> users, List<string> groups)
    {
        conn.Execute("DELETE FROM group_user_members WHERE group_id = @groupId", new { groupId }, tx);
        conn.Execute("DELETE FROM group_group_members WHERE group_id = @groupId", new { groupId }, tx);
        foreach (var u in users.Distinct(StringComparer.OrdinalIgnoreCase))
            conn.Execute("INSERT INTO group_user_members (group_id, user_id) VALUES (@groupId, @uid)",
                new { groupId, uid = Lookups.UserId(conn, tx, u) }, tx);
        foreach (var child in groups.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            var cid = Lookups.GroupId(conn, tx, child);
            if (cid == groupId) throw new AppException("A group cannot contain itself.");
            conn.Execute("INSERT INTO group_group_members (group_id, member_group_id) VALUES (@groupId, @cid)", new { groupId, cid }, tx);
        }
    }

    private static List<GroupDto> LoadGroups(IDbConnection conn, IDbTransaction? tx, string? only, string adminGroup)
    {
        var groups = conn.Query<(long Id, string Name, string Description)>(
            "SELECT id, name, description FROM groups ORDER BY name COLLATE NOCASE", transaction: tx).ToList();
        var users = conn.Query<(long GroupId, string Username)>(
            "SELECT m.group_id, u.username FROM group_user_members m JOIN users u ON u.id = m.user_id ORDER BY u.username COLLATE NOCASE",
            transaction: tx).ToLookup(x => x.GroupId, x => x.Username);
        var nested = conn.Query<(long GroupId, long ChildId)>(
            "SELECT group_id, member_group_id FROM group_group_members", transaction: tx).ToList();
        var ruleCounts = conn.Query<(string Name, int Count)>(
            "SELECT principal_name, COUNT(*) FROM access_rules WHERE principal_type = 'group' GROUP BY principal_name COLLATE NOCASE",
            transaction: tx).ToDictionary(x => x.Name, x => x.Count, StringComparer.OrdinalIgnoreCase);

        var byId = groups.ToDictionary(g => g.Id);
        var children = nested.ToLookup(n => n.GroupId, n => n.ChildId);
        var parents = nested.ToLookup(n => n.ChildId, n => n.GroupId);

        int EffectiveUsers(long id)
        {
            var seen = new HashSet<long>();
            var all = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var stack = new Stack<long>([id]);
            while (stack.Count > 0)
            {
                var g = stack.Pop();
                if (!seen.Add(g)) continue;
                foreach (var u in users[g]) all.Add(u);
                foreach (var c in children[g]) stack.Push(c);
            }
            return all.Count;
        }

        return groups
            .Where(g => only is null || g.Name.Equals(only, StringComparison.OrdinalIgnoreCase))
            .Select(g => new GroupDto(
                g.Name, g.Description,
                users[g.Id].ToList(),
                children[g.Id].Select(c => byId[c].Name).OrderBy(n => n, StringComparer.OrdinalIgnoreCase).ToList(),
                parents[g.Id].Select(p => byId[p].Name).OrderBy(n => n, StringComparer.OrdinalIgnoreCase).ToList(),
                ruleCounts.GetValueOrDefault(g.Name),
                EffectiveUsers(g.Id),
                g.Name.Equals(adminGroup, StringComparison.OrdinalIgnoreCase)))
            .ToList();
    }
}
