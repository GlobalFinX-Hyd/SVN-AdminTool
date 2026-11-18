using System.Security.Cryptography;
using System.Text.Json;
using Dapper;
using Fido2NetLib;
using Fido2NetLib.Objects;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;
using SvnAdmin.Data;

namespace SvnAdmin.Security;

/// <summary>
/// Passkeys (WebAuthn / FIDO2):
/// discoverable credentials (sign in without typing a username), user verification required,
/// challenges kept in memory for five minutes and usable once.
/// </summary>
public sealed class Passkeys(Db db, IMemoryCache cache, IOptions<SvnOptions> options, ILogger<Passkeys> logger)
{
    private const int MaxPerUser = 20;
    private static readonly TimeSpan ChallengeLifetime = TimeSpan.FromMinutes(5);
    private readonly SvnOptions _o = options.Value;

    public sealed record PasskeyDto(long Id, string Name, string CreatedAt, string? LastUsedAt, string Transports);
    private sealed record Pending(string OptionsJson, long? UserId);

    public (string Handle, JsonElement Options) RegisterOptions(long userId, string username, string displayName)
    {
        using var conn = db.Open();
        var existing = conn.Query<(byte[] CredentialId, byte[] UserHandle)>(
            "SELECT credential_id, user_handle FROM passkeys WHERE user_id = @userId", new { userId }).ToList();
        if (existing.Count >= MaxPerUser) throw new AppException($"You can register at most {MaxPerUser} passkeys. Remove one first.");

        var userHandle = existing.FirstOrDefault().UserHandle ?? RandomNumberGenerator.GetBytes(32);
        var options = Build().RequestNewCredential(new RequestNewCredentialParams
        {
            User = new Fido2User { Id = userHandle, Name = username, DisplayName = string.IsNullOrWhiteSpace(displayName) ? username : displayName },
            ExcludeCredentials = existing.Select(p => new PublicKeyCredentialDescriptor(p.CredentialId)).ToList(),
            AuthenticatorSelection = new AuthenticatorSelection
            {
                ResidentKey = ResidentKeyRequirement.Required,
                UserVerification = UserVerificationRequirement.Required,
            },
            AttestationPreference = AttestationConveyancePreference.None,
        });
        return Store(options.ToJson(), userId);
    }

    public async Task<PasskeyDto> RegisterAsync(long userId, string handle, JsonElement credential, string? name, string userAgent)
    {
        if (Take(handle) is not { } pending || pending.UserId != userId)
            throw new AppException("The passkey request expired. Please try again.");

        AuthenticatorAttestationRawResponse? attestation;
        try { attestation = credential.Deserialize<AuthenticatorAttestationRawResponse>(); }
        catch (JsonException) { attestation = null; }
        if (attestation is null) throw new AppException("Invalid passkey response.");

        RegisteredPublicKeyCredential cred;
        try
        {
            cred = await Build().MakeNewCredentialAsync(new MakeNewCredentialParams
            {
                AttestationResponse = attestation,
                OriginalOptions = CredentialCreateOptions.FromJson(pending.OptionsJson),
                IsCredentialIdUniqueToUserCallback = (args, _) =>
                {
                    using var c = db.Open();
                    return Task.FromResult(c.ExecuteScalar<long>("SELECT COUNT(*) FROM passkeys WHERE credential_id = @id", new { id = args.CredentialId }) == 0);
                },
            });
        }
        catch (Fido2VerificationException ex)
        {
            logger.LogWarning(ex, "Passkey registration failed for user {UserId}", userId);
            throw new AppException("The passkey could not be verified. Please try again.");
        }

        var finalName = Clean(name) ?? DefaultName(userAgent);
        using var conn = db.Open();
        var id = conn.ExecuteScalar<long>("""
            INSERT INTO passkeys (user_id, credential_id, public_key, user_handle, sign_count, aaguid, transports, name, created_at)
            VALUES (@userId, @cid, @pk, @uh, @sc, @aaguid, @tr, @name, @now) RETURNING id
            """, new
        {
            userId, cid = cred.Id, pk = cred.PublicKey, uh = cred.User.Id, sc = (long)cred.SignCount,
            aaguid = cred.AaGuid.ToString(),
            tr = cred.Transports is { Length: > 0 } t ? string.Join(',', t.Select(x => x.ToString().ToLowerInvariant())) : "",
            name = finalName, now = Clock.Now(),
        });
        Mfa.RefreshEnabledFlag(conn, null, userId);
        return List(userId).Single(p => p.Id == id);
    }

    public (string Handle, JsonElement Options) LoginOptions()
    {
        var options = Build().GetAssertionOptions(new GetAssertionOptionsParams
        {
            AllowedCredentials = [],
            UserVerification = UserVerificationRequirement.Required,
        });
        return Store(options.ToJson(), null);
    }

    /// <summary>Verifies a sign-in assertion. Returns the user id it belongs to.</summary>
    public async Task<long> VerifyLoginAsync(string handle, JsonElement credential)
    {
        const string failed = "That passkey could not be used to sign in.";
        if (Take(handle) is not { } pending || pending.UserId is not null)
            throw new AppException("The sign-in request expired. Please try again.", 401);

        AuthenticatorAssertionRawResponse? assertion;
        try { assertion = credential.Deserialize<AuthenticatorAssertionRawResponse>(); }
        catch (JsonException) { assertion = null; }
        if (assertion is null) throw new AppException(failed, 401);

        using var conn = db.Open();
        var pk = conn.QuerySingleOrDefault<(long Id, long UserId, byte[] PublicKey, byte[] UserHandle, long SignCount)>(
            "SELECT id, user_id, public_key, user_handle, sign_count FROM passkeys WHERE credential_id = @id", new { id = assertion.RawId });
        if (pk.Id == 0) throw new AppException("This passkey isn't registered with SVN Admin. It may have been removed.", 401);

        VerifyAssertionResult result;
        try
        {
            result = await Build().MakeAssertionAsync(new MakeAssertionParams
            {
                AssertionResponse = assertion,
                OriginalOptions = AssertionOptions.FromJson(pending.OptionsJson),
                StoredPublicKey = pk.PublicKey,
                StoredSignatureCounter = (uint)Math.Clamp(pk.SignCount, 0, uint.MaxValue),
                IsUserHandleOwnerOfCredentialIdCallback = (args, _) =>
                    Task.FromResult(args.UserHandle is not null && args.UserHandle.AsSpan().SequenceEqual(pk.UserHandle)),
            });
        }
        catch (Fido2VerificationException ex)
        {
            logger.LogWarning(ex, "Passkey sign-in failed for passkey {Id}", pk.Id);
            throw new AppException(failed, 401);
        }

        conn.Execute("UPDATE passkeys SET sign_count = @sc, last_used_at = @now WHERE id = @Id",
            new { sc = (long)result.SignCount, now = Clock.Now(), pk.Id });
        return pk.UserId;
    }

    public List<PasskeyDto> List(long userId)
    {
        using var conn = db.Open();
        return conn.Query<PasskeyDto>(
            "SELECT id AS Id, name AS Name, created_at AS CreatedAt, last_used_at AS LastUsedAt, transports AS Transports FROM passkeys WHERE user_id = @userId ORDER BY created_at",
            new { userId }).ToList();
    }

    public void Rename(long userId, long id, string? name)
    {
        var n = Clean(name) ?? throw new AppException("Enter a name.");
        using var conn = db.Open();
        if (conn.Execute("UPDATE passkeys SET name = @n WHERE id = @id AND user_id = @userId", new { n, id, userId }) == 0)
            throw new NotFoundException("Passkey not found.");
    }

    public string Delete(long userId, long id)
    {
        using var conn = db.Open();
        var name = conn.ExecuteScalar<string?>("SELECT name FROM passkeys WHERE id = @id AND user_id = @userId", new { id, userId })
            ?? throw new NotFoundException("Passkey not found.");
        conn.Execute("DELETE FROM passkeys WHERE id = @id", new { id });
        Mfa.RefreshEnabledFlag(conn, null, userId);
        return name;
    }

    private (string, JsonElement) Store(string optionsJson, long? userId)
    {
        var handle = Convert.ToHexString(RandomNumberGenerator.GetBytes(16));
        cache.Set("passkey-challenge:" + handle, new Pending(optionsJson, userId), ChallengeLifetime);
        return (handle, JsonDocument.Parse(optionsJson).RootElement.Clone());
    }

    private Pending? Take(string? handle)
    {
        if (string.IsNullOrWhiteSpace(handle) || handle.Length > 64) return null;
        var key = "passkey-challenge:" + handle;
        if (!cache.TryGetValue(key, out Pending? p)) return null;
        cache.Remove(key);
        return p;
    }

    private Fido2 Build()
    {
        var rpId = _o.Passkeys.RelyingPartyId;
        var origins = _o.Passkeys.Origins.Where(o => !string.IsNullOrWhiteSpace(o)).ToList();
        if (origins.Count == 0 && !string.IsNullOrWhiteSpace(_o.AppUrl)) origins.Add(_o.AppUrl);
        if (string.IsNullOrWhiteSpace(rpId) && origins.Count > 0) rpId = new Uri(origins[0]).Host;
        if (string.IsNullOrWhiteSpace(rpId)) throw new AppException("Passkeys are not set up: set Svn:AppUrl (or Svn:Passkeys:RelyingPartyId).");

        return new Fido2(new Fido2Configuration
        {
            RPID = rpId,
            RPName = string.IsNullOrWhiteSpace(_o.Passkeys.RelyingPartyName) ? _o.ProductName : _o.Passkeys.RelyingPartyName,
            Origins = origins.Select(o => o.TrimEnd('/')).ToHashSet(StringComparer.OrdinalIgnoreCase),
            TimestampDriftTolerance = 300000,
        });
    }

    private static string? Clean(string? name)
    {
        var n = name?.Trim();
        return string.IsNullOrEmpty(n) ? null : n.Length > 100 ? n[..100] : n;
    }

    private static string DefaultName(string ua)
    {
        var device = ua.Contains("Windows") ? "Windows" : ua.Contains("iPhone") ? "iPhone" : ua.Contains("iPad") ? "iPad"
                   : ua.Contains("Android") ? "Android" : ua.Contains("Mac OS") ? "Mac" : ua.Contains("Linux") ? "Linux" : null;
        return device is null ? "Passkey" : $"Passkey on {device}";
    }
}
