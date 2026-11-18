using System.Threading.RateLimiting;
using Dapper;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.Extensions.Options;
using SvnAdmin;
using SvnAdmin.Data;
using SvnAdmin.Endpoints;
using SvnAdmin.Security;
using SvnAdmin.Services;
using SvnAdmin.Svn;

var builder = WebApplication.CreateBuilder(new WebApplicationOptions
{
    Args = args,
    // A Windows service starts in System32, so point it at its own folder for appsettings.json and wwwroot.
    ContentRootPath = Microsoft.Extensions.Hosting.WindowsServices.WindowsServiceHelpers.IsWindowsService() ? AppContext.BaseDirectory : null,
});
builder.Host.UseWindowsService(o => o.ServiceName = "SvnAdmin");

// Server-specific overrides live here so redeploying never overwrites them.
builder.Configuration.AddJsonFile("appsettings.Local.json", optional: true, reloadOnChange: false);
builder.Services.Configure<SvnOptions>(builder.Configuration.GetSection("Svn"));
// Relative paths in config resolve from the app folder (or the project folder under "dotnet run").
var pathBase = builder.Environment.ContentRootPath;
builder.Services.PostConfigure<SvnOptions>(o =>
{
    string Abs(string p) => string.IsNullOrWhiteSpace(p) ? p : Path.GetFullPath(Path.Combine(pathBase, p));
    o.DatabasePath = Abs(o.DatabasePath);
    o.LogoFile = Abs(o.LogoFile);
    o.PasswdFile = Abs(o.PasswdFile);
    o.AuthzFile = Abs(o.AuthzFile);
    o.RepositoriesRoot = Abs(o.RepositoriesRoot);
    o.ArchiveRoot = Abs(o.ArchiveRoot);
    o.BackupRoot = Abs(o.BackupRoot);
    o.ConfigHistoryDir = Abs(o.ConfigHistoryDir);
    o.KeysDir = Abs(string.IsNullOrWhiteSpace(o.KeysDir) ? Path.Combine(Path.GetDirectoryName(o.DatabasePath)!, "keys") : o.KeysDir);
});
builder.Services.Configure<EmailOptions>(builder.Configuration.GetSection("Email"));
builder.Services.PostConfigure<EmailOptions>(o =>
{
    if (!string.IsNullOrWhiteSpace(o.PickupDirectory)) o.PickupDirectory = Path.GetFullPath(Path.Combine(pathBase, o.PickupDirectory));
});

// Sign-in cookies and encrypted TOTP secrets must survive restarts: keep the keys on disk, encrypted with DPAPI.
var keysDir = builder.Configuration["Svn:KeysDir"] is { Length: > 0 } kd ? kd
    : Path.Combine(Path.GetDirectoryName(Path.GetFullPath(Path.Combine(pathBase, builder.Configuration["Svn:DatabasePath"] ?? "data/svnadmin.db")))!, "keys");
var dataProtection = builder.Services.AddDataProtection().SetApplicationName("SvnAdmin")
    .PersistKeysToFileSystem(new DirectoryInfo(Path.GetFullPath(Path.Combine(pathBase, keysDir))));
if (OperatingSystem.IsWindows()) dataProtection.ProtectKeysWithDpapi(protectToLocalMachine: true);
builder.Services.AddMemoryCache();
builder.Services.AddSingleton<Db>();
builder.Services.AddSingleton<SvnCli>();
builder.Services.AddSingleton<ConfigSync>();
builder.Services.AddSingleton<RepoService>();
builder.Services.AddSingleton<BackupService>();
builder.Services.AddHostedService<BackupScheduler>();
builder.Services.AddSingleton<ActivityScanner>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<ActivityScanner>());
builder.Services.AddSingleton<EmailSender>();
builder.Services.AddSingleton<AccountLinks>();
builder.Services.AddSingleton<Mfa>();
builder.Services.AddSingleton<Passkeys>();

var idleMinutes = builder.Configuration.GetValue("Svn:SessionIdleMinutes", 30);
builder.Services.AddAuthentication(Sessions.MainScheme)
    .AddCookie(Sessions.MainScheme, o =>
    {
        o.Cookie.Name = "svnadmin.auth";
        o.Cookie.HttpOnly = true;
        o.Cookie.SameSite = SameSiteMode.Strict;
        o.Cookie.SecurePolicy = CookieSecurePolicy.SameAsRequest; // HTTPS behind Apache via X-Forwarded-Proto
        o.ExpireTimeSpan = TimeSpan.FromMinutes(idleMinutes);
        o.SlidingExpiration = true;
        o.Events.OnRedirectToLogin = ctx => { ctx.Response.StatusCode = 401; return Task.CompletedTask; };
        o.Events.OnRedirectToAccessDenied = ctx => { ctx.Response.StatusCode = 403; return Task.CompletedTask; };
        // Re-checked on every request: disabling a user or changing the admin group takes effect at once.
        o.Events.OnValidatePrincipal = Sessions.Validate;
    })
    .AddCookie(Sessions.PendingScheme, o =>
    {
        o.Cookie.Name = "svnadmin.mfa";
        o.Cookie.HttpOnly = true;
        o.Cookie.SameSite = SameSiteMode.Strict;
        o.Cookie.SecurePolicy = CookieSecurePolicy.SameAsRequest;
        o.ExpireTimeSpan = TimeSpan.FromMinutes(5);
        o.SlidingExpiration = false;
    });
builder.Services.AddAuthorization(o =>
{
    o.FallbackPolicy = new Microsoft.AspNetCore.Authorization.AuthorizationPolicyBuilder(Sessions.MainScheme).RequireAuthenticatedUser().Build();
    o.AddPolicy(Sessions.AdminPolicy, p => p.AddAuthenticationSchemes(Sessions.MainScheme).RequireRole("admin"));
});
builder.Services.AddAntiforgery(o =>
{
    o.HeaderName = "X-XSRF-TOKEN";
    o.Cookie.Name = "svnadmin.af";
    o.Cookie.SameSite = SameSiteMode.Strict;
    o.Cookie.SecurePolicy = CookieSecurePolicy.SameAsRequest;
});

var loginLimit = builder.Configuration.GetValue("Svn:LoginAttemptsPerMinute", 10);
builder.Services.AddRateLimiter(o =>
{
    o.RejectionStatusCode = 429;
    o.OnRejected = (ctx, ct) => new ValueTask(ctx.HttpContext.Response.WriteAsJsonAsync(
        new { message = "Too many attempts from your network. Wait a minute and try again." }, ct));
    o.AddPolicy("login", ctx => RateLimitPartition.GetFixedWindowLimiter(
        ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown",
        _ => new FixedWindowRateLimiterOptions { PermitLimit = loginLimit, Window = TimeSpan.FromMinutes(1) }));
    o.AddPolicy("public", ctx => RateLimitPartition.GetFixedWindowLimiter(
        ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown",
        _ => new FixedWindowRateLimiterOptions { PermitLimit = 10, Window = TimeSpan.FromMinutes(5) }));
});

builder.Services.Configure<ForwardedHeadersOptions>(o =>
{
    // Apache on the same machine is the only trusted proxy (loopback is trusted by default).
    o.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
});

builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase);

var app = builder.Build();

// ------------------------------------------------------------------ startup: database + first import
var db = app.Services.GetRequiredService<Db>();
db.Migrate();
using (var conn = db.Open())
{
    if (conn.ExecuteScalar<long>("SELECT COUNT(*) FROM users") == 0)
    {
        var warnings = app.Services.GetRequiredService<ConfigSync>().ImportInitial(Actor.System);
        foreach (var w in warnings) app.Logger.LogWarning("Import: {Warning}", w);
    }
}
app.Services.GetRequiredService<RepoService>().SyncFromDisk();

// ------------------------------------------------------------------ pipeline
app.UseForwardedHeaders();
app.Use(async (ctx, next) =>
{
    var h = ctx.Response.Headers;
    h["X-Content-Type-Options"] = "nosniff";
    h["X-Frame-Options"] = "DENY";
    h["Referrer-Policy"] = "no-referrer";
    h["Content-Security-Policy"] =
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; " +
        "font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
    if (ctx.Request.Path.StartsWithSegments("/api")) h.CacheControl = "no-store";
    await next();
});
app.UseAppErrors();
app.UseDefaultFiles();
app.UseStaticFiles();
app.UseRateLimiter();
app.UseAuthentication();
app.UseAuthorization();

// CSRF: every state-changing API call must carry the X-XSRF-TOKEN header (Angular sends it automatically).
app.Use(async (ctx, next) =>
{
    var method = ctx.Request.Method;
    var path = ctx.Request.Path;
    // Exempt: steps before a session exists (protected by SameSite=Strict cookies and rate limits), and sign-out.
    var exempt = path.StartsWithSegments("/api/auth/login") || path.StartsWithSegments("/api/auth/mfa") ||
                 path.StartsWithSegments("/api/auth/passkey") || path.StartsWithSegments("/api/auth/logout") ||
                 path.StartsWithSegments("/api/public");
    if (path.StartsWithSegments("/api") && !HttpMethods.IsGet(method) && !HttpMethods.IsHead(method) && !exempt)
    {
        var af = ctx.RequestServices.GetRequiredService<IAntiforgery>();
        if (!await af.IsRequestValidAsync(ctx))
        {
            ctx.Response.StatusCode = 400;
            await ctx.Response.WriteAsJsonAsync(new { message = "Your session security token is missing or expired. Reload the page and try again." });
            return;
        }
    }
    await next();
});

app.MapAuth();
app.MapAccount();

// Everything below needs an admin (in the admin group, and signed in with MFA when RequireAdminMfa is on).
var admin = app.MapGroup("").RequireAuthorization(Sessions.AdminPolicy);
admin.MapUsers();
admin.MapGroups();
admin.MapAccess();
admin.MapRepos();
admin.MapAdmin();
admin.MapReports();
app.MapGet("/api/health", () => Results.Ok(new { ok = true })).AllowAnonymous();

// Branding: product name and an optional custom logo (Svn:ProductName, Svn:LogoFile).
app.MapGet("/api/public/branding", (IOptions<SvnOptions> opt) =>
    Results.Ok(new { productName = string.IsNullOrWhiteSpace(opt.Value.ProductName) ? "SVN Admin" : opt.Value.ProductName.Trim() }))
    .AllowAnonymous();
app.MapGet("/api/public/logo", (IOptions<SvnOptions> opt) =>
{
    var file = opt.Value.LogoFile;
    if (string.IsNullOrWhiteSpace(file) || !File.Exists(file)) return Results.Redirect("/logo.png");
    var type = Path.GetExtension(file).ToLowerInvariant() switch
    {
        ".svg" => "image/svg+xml", ".ico" => "image/x-icon", ".jpg" or ".jpeg" => "image/jpeg", ".webp" => "image/webp", _ => "image/png",
    };
    return Results.File(Path.GetFullPath(file), type);
}).AllowAnonymous();
app.Map("/api/{**rest}", () => Results.NotFound(new { message = "Unknown API endpoint." }));

// Angular routes: anything that is not /api or a real file gets index.html.
app.MapFallbackToFile("index.html").AllowAnonymous();

app.Run();


// Lets the integration tests start the app (WebApplicationFactory<Program>).
public partial class Program;