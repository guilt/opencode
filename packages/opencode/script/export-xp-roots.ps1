param([string]$Out = (Join-Path $env:TEMP "opencode\xp-roots.reg"))
New-Item -ItemType Directory -Force (Split-Path $Out) | Out-Null
$roots = Get-ChildItem Cert:\LocalMachine\Root |
  Where-Object { $_.Subject -eq $_.Issuer -and $_.NotAfter -gt (Get-Date) }
$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine("Windows Registry Editor Version 5.00")
foreach ($c in $roots) {
    $t = $c.Thumbprint.ToLower()
    $der = $c.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert)
    $hex = New-Object string[] $der.Length
    for ($i = 0; $i -lt $der.Length; $i++) { $hex[$i] = $der[$i].ToString("x2") }
    [void]$sb.AppendLine("")
    [void]$sb.AppendLine("[HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\SystemCertificates\Root\Certificates\$t]")
    for ($i = 0; $i -lt $hex.Length; $i += 20) {
        $end = [Math]::Min($i + 19, $hex.Length - 1)
        $chunk = ($hex[$i..$end] -join ",")
        $last = ($end -eq $hex.Length - 1)
        if ($i -eq 0) {
            $line = "`"$t`"=hex:$chunk"
        } else {
            $line = "  $chunk"
        }
        if (-not $last) { $line += ",\" }
        [void]$sb.AppendLine($line)
    }
}
[IO.File]::WriteAllText($Out, $sb.ToString(), [Text.Encoding]::ASCII)
Write-Output "roots exported: $($roots.Count)"
Write-Output "file: $Out ($((Get-Item $Out).Length) bytes)"
