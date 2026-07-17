# WebSocket Communication Protocol Analysis

## Current Implementation Issues

The current TypeScript implementation does **NOT** match the PowerShell script's protocol:

### ❌ Issue 1: Authentication Method
```
PowerShell:  Authorization: Basic base64(username:password)
Current TS:  Authorization: Bearer {token}
```

### ❌ Issue 2: Protocol Format
```
PowerShell:  JSON-RPC 2.0 with request IDs, newline-delimited
Current TS:  Custom simplified protocol
```

### ❌ Issue 3: Session Lifecycle
```
PowerShell:  Full lifecycle (initialize → authenticate → session management → prompts)
Current TS:  No session initialization or management
```

### ❌ Issue 4: Message Format
```
PowerShell:  {"jsonrpc":"2.0","id":"1","method":"session/prompt","params":{...}}
Current TS:  {"type":"session/message","sessionId":"...","message":"..."}
```

---

## PowerShell Script Protocol Analysis

### Authentication
```powershell
$auth = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes("$User`:$Token"))
$ws.Options.SetRequestHeader("Authorization", "Basic $auth")
```
**Default User**: "token" (if not specified)  
**Auth Header**: `Authorization: Basic base64(username:password)`

### JSON-RPC 2.0 Protocol
All messages follow this structure:
```json
{
  "jsonrpc": "2.0",
  "id": "1",
  "method": "method_name",
  "params": { ... }
}
```

Response structure:
```json
{
  "jsonrpc": "2.0",
  "id": "1",
  "result": { ... }
}
```

Error structure:
```json
{
  "jsonrpc": "2.0",
  "id": "1",
  "error": {
    "code": -32601,
    "message": "Method not found"
  }
}
```

### Message Framing
- **Delimiter**: Newline character (`\n`)
- **Format**: UTF-8 encoded JSON + newline
- **Receiving**: Buffered line-by-line reading

### Session Lifecycle

#### 1. Initialize
```json
{
  "jsonrpc": "2.0",
  "id": "1",
  "method": "initialize",
  "params": {
    "protocolVersion": 1,
    "clientCapabilities": {}
  }
}
```

Response includes:
- `protocolVersion`: Must match
- `authMethods`: Array of available authentication methods
- `agentCapabilities`: What the backend supports
  - `auth.logout`: Supports logout
  - `loadSession`: Supports session/load method

#### 2. Authenticate (if requested)
```json
{
  "jsonrpc": "2.0",
  "id": "2",
  "method": "authenticate",
  "params": {
    "methodId": "{methodId from authMethods}"
  }
}
```

#### 3. Session Management (choose one path)

**Path A: Load Existing Session**
```json
{
  "jsonrpc": "2.0",
  "id": "3",
  "method": "session/load",
  "params": {
    "sessionId": "previous-session-id",
    "cwd": "/workspace",
    "mcpServers": []
  }
}
```

**Path B: Resume Session**
```json
{
  "jsonrpc": "2.0",
  "id": "3",
  "method": "session/resume",
  "params": {
    "sessionId": "previous-session-id"
  }
}
```

**Path C: Create New Session**
```json
{
  "jsonrpc": "2.0",
  "id": "3",
  "method": "session/new",
  "params": {
    "cwd": "/workspace",
    "mcpServers": []
  }
}
```

#### 4. Set Configuration
```json
{
  "jsonrpc": "2.0",
  "id": "4",
  "method": "session/set_config_option",
  "params": {
    "sessionId": "session-id-here",
    "configId": "agent",
    "value": "ACP-Chatbot"
  }
}
```

#### 5. Send Prompt/Message
```json
{
  "jsonrpc": "2.0",
  "id": "5",
  "method": "session/prompt",
  "params": {
    "sessionId": "session-id-here",
    "prompt": [
      {
        "type": "text",
        "text": "User's message here"
      }
    ]
  }
}
```

Response:
```json
{
  "jsonrpc": "2.0",
  "id": "5",
  "result": {
    "stopReason": "completion|stop|length|error|..."
  }
}
```

### Server-Initiated Messages

#### 1. Session Updates (Streaming Output)
```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "update": {
      "sessionUpdate": "agent_message_chunk",
      "content": {
        "type": "text",
        "text": "Partial response text here"
      }
    }
  }
}
```

#### 2. Permission Requests
```json
{
  "jsonrpc": "2.0",
  "id": "123",
  "method": "session/request_permission",
  "params": {
    "permission": "..."
  }
}
```

Response required:
```json
{
  "jsonrpc": "2.0",
  "id": "123",
  "result": {
    "outcome": {
      "outcome": "approved|cancelled"
    }
  }
}
```

---

## Environment Configuration

From `.env` file in PowerShell script:
```
WEBSOCKET_USER=token              # Default: "token"
WEBSOCKET_TOKEN={auth_token}      # Required
ACP_AUTH_METHOD_ID={methodId}     # Optional (if authentication required)
ACP_WEBSOCKET_PORT=8080           # Optional, can be overridden by -Port
```

Current project `.env`:
```
WEBSOCKET_URL=ws://4.205.223.121:8080/ws
WEBSOCKET_AUTH_TOKEN=mYLONGlivetok3nskd!dk
```

⚠️ **Issue**: Missing `WEBSOCKET_USER` configuration. Should be "token" by default.

---

## Summary of Required Changes

### Authentication
- [ ] Change from `Bearer` to `Basic` auth
- [ ] Calculate Base64 of `{username}:{token}`
- [ ] Add username configuration (default: "token")

### Protocol
- [ ] Implement JSON-RPC 2.0 message format
- [ ] Add request ID tracking
- [ ] Implement newline-delimited message framing
- [ ] Add proper response ID matching

### Session Management
- [ ] Implement initialize method
- [ ] Add authenticate method support
- [ ] Implement session/load for resuming
- [ ] Implement session/new for creating
- [ ] Add session/set_config_option for agent config

### Message Handling
- [ ] Implement session/prompt for sending messages
- [ ] Handle session/update server-pushed messages
- [ ] Handle session/request_permission callbacks
- [ ] Support streaming/chunked responses

### Error Handling
- [ ] Proper JSON-RPC error responses
- [ ] Timeout handling
- [ ] Connection retry logic
- [ ] Graceful degradation for unsupported methods

### Configuration
- [ ] Add WEBSOCKET_USER to .env (default: "token")
- [ ] Ensure WEBSOCKET_TOKEN is properly set
- [ ] Support optional ACP_AUTH_METHOD_ID
- [ ] Document all required environment variables
