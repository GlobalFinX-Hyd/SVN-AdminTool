namespace SvnAdmin;

/// <summary>Settings bound from the "Svn" section of appsettings.json.</summary>
public sealed class SvnOptions
{
    /// <summary>Name shown in the UI, the authenticator app, passkey prompts and emails.</summary>
    public string ProductName { get; set; } = "SVN Admin";

    /// <summary>Optional PNG, SVG or ICO file used as the logo. Empty = the built-in logo.</summary>
    public string LogoFile { get; set; } = "";

    /// <summary>SQLite database file. Its folder is created if missing.</summary>
    public string DatabasePath { get; set; } = "data/svnadmin.db";

    /// <summary>Apache AuthUserFile (htpasswd format). Generated from the database.</summary>
    public string PasswdFile { get; set; } = "";

    /// <summary>Apache AuthzSVNAccessFile. Generated from the database.</summary>
    public string AuthzFile { get; set; } = "";

    /// <summary>SVNParentPath: folder holding one sub-folder per repository.</summary>
    public string RepositoriesRoot { get; set; } = "";

    /// <summary>Where archived repositories are moved to. Must be on the same drive as RepositoriesRoot.</summary>
    public string ArchiveRoot { get; set; } = "";

    /// <summary>Root folder for config backups (passwd, authz and SvnAdmin database snapshots).</summary>
    public string BackupRoot { get; set; } = "";

    /// <summary>Keeps a copy of every previous passwd/authz file before it is replaced.</summary>
    public string ConfigHistoryDir { get; set; } = "";

    /// <summary>How many old passwd/authz copies to keep in ConfigHistoryDir.</summary>
    public int ConfigHistoryKeep { get; set; } = 200;

    /// <summary>Folder with svn.exe, svnadmin.exe and svnlook.exe. Empty means use PATH.</summary>
    public string SvnBinDir { get; set; } = "";

    /// <summary>Members of this authz group (directly or through nested groups) can sign in to SvnAdmin.</summary>
    public string AdminGroup { get; set; } = "itadmins";

    /// <summary>Base URL developers use for checkouts, e.g. https://svn.example.com. Shown in the UI.</summary>
    public string PublicUrl { get; set; } = "";

    public int MinPasswordLength { get; set; } = 10;

    public int MaxFailedLogins { get; set; } = 5;

    public int LockoutMinutes { get; set; } = 15;

    public int SessionIdleMinutes { get; set; } = 30;

    /// <summary>Passwords older than this are flagged in the UI (not enforced). 0 disables.</summary>
    public int PasswordMaxAgeDays { get; set; } = 365;

    /// <summary>Public address of SvnAdmin itself, used in email links, e.g. https://svnadmin.example.com</summary>
    public string AppUrl { get; set; } = "";

    /// <summary>Admins must set up an authenticator app or passkey before they can use admin pages.</summary>
    public bool RequireAdminMfa { get; set; } = true;

    public int WelcomeLinkHours { get; set; } = 72;

    public int ResetLinkMinutes { get; set; } = 60;

    /// <summary>Default for the "inactive users" report.</summary>
    public int DormantDays { get; set; } = 180;

    /// <summary>Folder for ASP.NET Data Protection keys (sign-in cookies, encrypted TOTP secrets). Empty = next to the database.</summary>
    public string KeysDir { get; set; } = "";

    public PasskeyOptions Passkeys { get; set; } = new();
}

public sealed class PasskeyOptions
{
    /// <summary>WebAuthn relying party ID: the host name the site is served on, e.g. svnadmin.example.com.
    /// Changing it later invalidates every registered passkey.</summary>
    public string RelyingPartyId { get; set; } = "";

    /// <summary>Name shown in passkey prompts. Empty = ProductName.</summary>
    public string RelyingPartyName { get; set; } = "";

    /// <summary>Allowed origins, e.g. https://svnadmin.example.com. Empty = AppUrl.</summary>
    public string[] Origins { get; set; } = [];
}

/// <summary>SMTP settings ("Email" section). Usually port 587 (STARTTLS).</summary>
public sealed class EmailOptions
{
    public bool Enabled { get; set; }
    public string Host { get; set; } = "";
    public int Port { get; set; } = 587;
    public string Username { get; set; } = "";
    public string Password { get; set; } = "";
    public string FromAddress { get; set; } = "";
    public string FromName { get; set; } = "SVN Admin";
    /// <summary>Copy of every email for testing. Leave empty in production.</summary>
    public string BccAddress { get; set; } = "";
    /// <summary>Development only: write emails to this folder instead of sending them.</summary>
    public string PickupDirectory { get; set; } = "";
}
