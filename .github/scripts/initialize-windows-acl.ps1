$ErrorActionPreference = 'Stop'
$clock = [Diagnostics.Stopwatch]::StartNew()
$probe = $null
$probeFile = $null
$initialized = $false
try {
    if (-not $env:RUNNER_TEMP) { throw 'Missing runner temporary directory' }
    $probe = Join-Path $env:RUNNER_TEMP ('agent-dialogue-acl-init-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $probe -ErrorAction Stop | Out-Null
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $directoryAcl = New-Object Security.AccessControl.DirectorySecurity
    $directoryAcl.SetOwner($sid)
    $directoryAcl.SetAccessRuleProtection($true, $false)
    $directoryRule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $directoryAcl.AddAccessRule($directoryRule)
    [IO.Directory]::SetAccessControl($probe, $directoryAcl)
    $probeFile = Join-Path $probe 'empty-probe'
    $handle = [IO.File]::Open($probeFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $handle.Dispose()
    $fileAcl = New-Object Security.AccessControl.FileSecurity
    $fileAcl.SetOwner($sid)
    $fileAcl.SetAccessRuleProtection($true, $false)
    $fileRule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')
    $fileAcl.AddAccessRule($fileRule)
    [IO.File]::SetAccessControl($probeFile, $fileAcl)
    $directoryCheck = [IO.Directory]::GetAccessControl($probe)
    $fileCheck = [IO.File]::GetAccessControl($probeFile)
    foreach ($acl in @($directoryCheck, $fileCheck)) {
        if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $sid.Value -or -not $acl.AreAccessRulesProtected) { throw 'Metadata check failed' }
        $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
        if ($rules.Count -ne 1 -or $rules[0].IdentityReference.Value -cne $sid.Value -or $rules[0].AccessControlType -ne 'Allow' -or $rules[0].IsInherited -or ([long]$rules[0].FileSystemRights -band 1) -eq 0) { throw 'ACL check failed' }
    }
    $initialized = $true
} catch {
    # Leave failed initialization objects for diagnosis; never modify an old
    # fixture or print its path, SID, command arguments or exception details.
    [Console]::Error.WriteLine('Windows ACL write runtime initialization failed; owned diagnostic objects retained')
    exit 1
}
if ($initialized) {
    try {
        # Exact new empty objects only. Directory.Delete is deliberately not
        # recursive, so an unexpected extra object is retained and fails.
        [IO.File]::Delete($probeFile)
        [IO.Directory]::Delete($probe)
    } catch {
        [Console]::Error.WriteLine('Windows ACL initialization cleanup failed; owned diagnostic objects retained')
        exit 1
    }
    [Console]::Out.WriteLine(('Windows ACL write runtime initialized; directory=1; file=1; elapsedMs=' + $clock.ElapsedMilliseconds))
}
