namespace SvnAdmin;

/// <summary>A problem the admin can fix (bad input, rule violated). Returned as 400 with the message.</summary>
public class AppException(string message, int status = 400) : Exception(message)
{
    public int Status { get; } = status;
}

public sealed class NotFoundException(string message) : AppException(message, 404);

public sealed class ConflictException(string message) : AppException(message, 409);

public static class ErrorHandling
{
    public static IApplicationBuilder UseAppErrors(this IApplicationBuilder app) => app.Use(async (ctx, next) =>
    {
        try
        {
            await next();
        }
        catch (AppException ex) when (!ctx.Response.HasStarted)
        {
            ctx.Response.StatusCode = ex.Status;
            await ctx.Response.WriteAsJsonAsync(new { message = ex.Message });
        }
        catch (Exception ex) when (!ctx.Response.HasStarted && ex is not OperationCanceledException)
        {
            ctx.RequestServices.GetRequiredService<ILogger<AppException>>().LogError(ex, "Unhandled error on {Path}", ctx.Request.Path);
            ctx.Response.StatusCode = 500;
            await ctx.Response.WriteAsJsonAsync(new { message = "Unexpected server error. Details are in the SvnAdmin log." });
        }
    });
}
