using System.Data;
using Dapper;
using SvnAdmin.Data;

namespace SvnAdmin.Services;

/// <summary>Who did what, when, from where. Written in the same transaction as the change itself.</summary>
public static class Audit
{
    public static void Write(IDbConnection conn, IDbTransaction? tx, Actor actor, string action, string target, string details = "")
    {
        conn.Execute(
            "INSERT INTO audit_log (at, actor, action, target, details, ip) VALUES (@at, @actor, @action, @target, @details, @ip)",
            new { at = Clock.Now(), actor = actor.Name, action, target, details, ip = actor.Ip }, tx);
    }
}

/// <summary>The person (or "system") making a change.</summary>
public sealed record Actor(string Name, string Ip)
{
    public static readonly Actor System = new("system", "");

    public static Actor From(HttpContext ctx) =>
        new(ctx.User.Identity?.Name ?? "anonymous", ctx.Connection.RemoteIpAddress?.ToString() ?? "");
}
