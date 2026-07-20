param(
    [string]$BotUrl = "http://localhost:3978",
    [string]$ChannelId = "msteams",
    [string]$UserId = "sim-user-001",
    [string]$UserName = "Simulated User",
    [string]$UserAADId = "12345678-1234-1234-1234-123456789012",
    [string]$ConversationId,
    [string]$TenantId = "9cbd3073-3291-419c-ad86-3dd8860cad5f",
    [string]$BotId = "28:d4c09dd1-ab88-4b8c-9a98-3199b8519fb8",
    [string]$BotName = "ACP Bot",
    [string]$Question,
    [switch]$Verbose
)

$ErrorActionPreference = "Stop"

# Default to interactive chat mode when no Question is supplied
$Interactive = [string]::IsNullOrWhiteSpace($Question)

# Generate a conversation ID if not provided
if ([string]::IsNullOrWhiteSpace($ConversationId)) {
    $ConversationId = "19:room-" + [System.Guid]::NewGuid().ToString("N").Substring(0, 12) + "@thread.skype"
}

$DevMessagesEndpoint = "$BotUrl/api/dev/messages"
$HealthEndpoint      = "$BotUrl/healthz"

# ──────────────────────────────────────────────────────────────────────────────
# Build a complete Bot Framework Activity
# ──────────────────────────────────────────────────────────────────────────────
function New-BotFrameworkActivity {
    param(
        [string]$Type = "message",
        [string]$Text = ""
    )

    $activity = @{
        type           = $Type
        id             = [System.Guid]::NewGuid().ToString()
        timestamp      = (Get-Date).ToUniversalTime().ToString("o")
        localTimestamp = (Get-Date).ToString("o")
        serviceUrl     = "https://smba.trafficmanager.net/amer/"
        channelId      = $ChannelId
        from           = @{
            id          = $UserId
            name        = $UserName
            aadObjectId = $UserAADId
        }
        conversation   = @{
            id               = $ConversationId
            isGroup          = $false
            conversationType = "personal"
            tenantId         = $TenantId
        }
        recipient      = @{
            id   = $BotId
            name = $BotName
        }
        textFormat     = "plain"
        locale         = "en-US"
        channelData    = @{
            teamsChannelId = $ConversationId
            teamsTeamId    = "19:team@thread.skype"
            tenant         = @{
                id = $TenantId
            }
        }
    }

    if ($Type -eq "message" -and -not [string]::IsNullOrWhiteSpace($Text)) {
        $activity.text = $Text
    }

    return $activity
}

# ──────────────────────────────────────────────────────────────────────────────
# Send activity and return the response
# ──────────────────────────────────────────────────────────────────────────────
function Send-BotActivity {
    param([object]$Activity)

    $body = $Activity | ConvertTo-Json -Depth 10 -Compress

    if ($Verbose) {
        Write-Host "[DEBUG] POST $DevMessagesEndpoint" -ForegroundColor DarkGray
        Write-Host "[DEBUG] Body: $body" -ForegroundColor DarkGray
    }

    $response = Invoke-WebRequest `
        -Uri         $DevMessagesEndpoint `
        -Method      POST `
        -ContentType "application/json" `
        -Body        $body `
        -ErrorAction Stop

    return $response
}

# ──────────────────────────────────────────────────────────────────────────────
# Health check
# ──────────────────────────────────────────────────────────────────────────────
Write-Host "──────────────────────────────────────────" -ForegroundColor Cyan
Write-Host " Teams Client Simulation (Full Activity)" -ForegroundColor Cyan
Write-Host " Bot URL        : $BotUrl" -ForegroundColor Cyan
Write-Host " Channel        : $ChannelId" -ForegroundColor Cyan
Write-Host " Conversation   : $ConversationId" -ForegroundColor Cyan
Write-Host " User           : $UserName ($UserId)" -ForegroundColor Cyan
Write-Host "──────────────────────────────────────────" -ForegroundColor Cyan

Write-Host ""
Write-Host "Checking bot health..." -ForegroundColor Yellow
try {
    $health = Invoke-RestMethod -Uri $HealthEndpoint -Method GET -ErrorAction Stop
    $wsStatus = if ($health.wsReady) { "connected" } else { "not connected" }
    Write-Host "  status   : $($health.status)" -ForegroundColor Green
    Write-Host "  wsReady  : $wsStatus" -ForegroundColor $(if ($health.wsReady) { "Green" } else { "Red" })
    Write-Host "  sessions : $($health.sessionsInMemory) in memory" -ForegroundColor Green
}
catch {
    Write-Host "  Health check FAILED: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "  Is the bot running at $BotUrl ?" -ForegroundColor Red
    exit 1
}

Write-Host ""

# ──────────────────────────────────────────────────────────────────────────────
# Send initial conversationUpdate (simulates Teams connection)
# ──────────────────────────────────────────────────────────────────────────────
Write-Host "Sending initial conversationUpdate..." -ForegroundColor Yellow
try {
    $initActivity = New-BotFrameworkActivity -Type "conversationUpdate"
    Send-BotActivity -Activity $initActivity | Out-Null
    Write-Host "  Conversation initialized" -ForegroundColor Green
}
catch {
    Write-Host "  Warning: Failed to send conversationUpdate: $($_.Exception.Message)" -ForegroundColor Yellow
}

Write-Host ""

# ──────────────────────────────────────────────────────────────────────────────
# Single-shot mode: one question, then exit
# ──────────────────────────────────────────────────────────────────────────────
if (-not $Interactive -and -not [string]::IsNullOrWhiteSpace($Question)) {
    Write-Host "You  > $Question" -ForegroundColor White

    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    $activity  = New-BotFrameworkActivity -Type "message" -Text $Question
    $response  = Send-BotActivity -Activity $activity
    $stopwatch.Stop()

    Write-Host "Bot  > (HTTP $($response.StatusCode), $($stopwatch.ElapsedMilliseconds)ms)" -ForegroundColor Cyan

    if ($response.Content) {
        try {
            $parsed = $response.Content | ConvertFrom-Json
            if ($parsed.text) {
                Write-Host "Bot  > $($parsed.text)" -ForegroundColor Green
            } else {
                Write-Host $response.Content -ForegroundColor Green
            }
        }
        catch {
            Write-Host $response.Content -ForegroundColor Green
        }
    }
    exit 0
}

# ──────────────────────────────────────────────────────────────────────────────
# Interactive loop — runs until Ctrl+C or /close
# ──────────────────────────────────────────────────────────────────────────────
Write-Host "Interactive mode — type messages or /close to end. Press Ctrl+C to force exit." -ForegroundColor Yellow
Write-Host ""

$turn = 0
while ($true) {
    try {
        $input = Read-Host "You "
    } catch {
        Write-Host "`nExiting." -ForegroundColor Gray
        break
    }

    if ([string]::IsNullOrWhiteSpace($input)) {
        continue
    }

    # Handle /close command
    if ($input -eq "/close") {
        Write-Host "Bot  > " -NoNewline -ForegroundColor Cyan
        try {
            $closeActivity = New-BotFrameworkActivity -Type "endOfConversation"
            $response = Send-BotActivity -Activity $closeActivity
            Write-Host "Conversation closed" -ForegroundColor Green
            Write-Host ""
            Write-Host "Session ended. Exiting." -ForegroundColor Gray
            break
        }
        catch {
            Write-Host "ERROR: Failed to close conversation: $($_.Exception.Message)" -ForegroundColor Red
        }
        continue
    }

    $turn++
    Write-Host "Bot  > " -NoNewline -ForegroundColor Cyan

    try {
        $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
        $activity  = New-BotFrameworkActivity -Type "message" -Text $input
        $response  = Send-BotActivity -Activity $activity
        $stopwatch.Stop()

        if ($response.Content) {
            try {
                $parsed = $response.Content | ConvertFrom-Json
                if ($parsed.text) {
                    Write-Host $parsed.text -ForegroundColor Green
                } else {
                    Write-Host $response.Content -ForegroundColor Green
                }
            }
            catch {
                Write-Host $response.Content -ForegroundColor Green
            }
        } else {
            Write-Host "(no response body)" -ForegroundColor DarkGray
        }

        if ($Verbose) {
            Write-Host "       [turn $turn, $($stopwatch.ElapsedMilliseconds)ms, HTTP $($response.StatusCode)]" -ForegroundColor DarkGray
        }
    }
    catch {
        $status  = if ($_.Exception.Response) { $_.Exception.Response.StatusCode.value__ } else { "ERR" }
        $message = $_.Exception.Message
        Write-Host "ERROR (HTTP $status): $message" -ForegroundColor Red
    }

    Write-Host ""
}
