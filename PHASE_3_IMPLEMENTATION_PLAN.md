# Phase 3 Implementation Plan: WebSocket Session Management

## Overview
Implement proper JSON-RPC 2.0 protocol communication with the backend WebSocket endpoint, with full session lifecycle management.

---

## Architecture Changes Required

### 1. WebSocket Connection Manager
**File**: `src/websocketManager.ts` (NEW)

**Responsibility**: 
- Manage single persistent connection per bot session
- Handle JSON-RPC 2.0 message format
- Track pending requests with IDs
- Manage authentication

**Key Features**:
```typescript
class WebSocketManager {
  // Initialize connection
  connect(url, username, token): Promise<InitializeResult>
  
  // Send JSON-RPC request and wait for response
  request(method, params): Promise<any>
  
  // Handle server-pushed messages
  on(eventName, callback): void
  
  // Clean shutdown
  disconnect(): Promise<void>
  
  // Retry logic
  reconnect(): Promise<void>
}
```

### 2. Session Store Enhancement
**File**: `src/sessionStore.ts` (MODIFY)

**Current Structure**:
```typescript
interface SessionState {
  effectiveId: string;  // Should be renamed to sessionId
}
```

**New Structure**:
```typescript
interface SessionState {
  // Identification
  channelId: string;
  conversationId: string;
  userId: string;
  
  // Session Management
  sessionId: string;           // From backend session/new or session/load
  sessionCreatedAt: Date;
  lastActivityAt: Date;
  
  // Configuration
  agentName: string;           // "ACP-Chatbot" or configured agent
  
  // Metadata
  sessionMode: "new" | "resumed" | "loaded";
  backendCapabilities: {
    supportsLogout?: boolean;
    supportsLoadSession?: boolean;
  };
}
```

### 3. WebSocket Bridge Refactor
**File**: `src/websocketBridge.ts` (REWRITE)

Current: Simple send/receive  
New: Full JSON-RPC lifecycle management

**Functions to Implement**:
```typescript
// Initialization phase
async function initializeBackendSession(
  manager: WebSocketManager,
  config: AppConfig
): Promise<InitializeResult>

// Authentication phase (if needed)
async function authenticateBackend(
  manager: WebSocketManager,
  authMethodId: string
): Promise<void>

// Session creation/loading phase
async function createOrLoadSession(
  manager: WebSocketManager,
  sessionStore: SessionStore,
  conversationKey: string,
  previousSessionId?: string
): Promise<string>

// Configuration phase
async function configureSession(
  manager: WebSocketManager,
  sessionId: string,
  agentName: string
): Promise<void>

// Message send phase
async function sendPrompt(
  manager: WebSocketManager,
  sessionId: string,
  userMessage: string
): Promise<string>

// Handle server updates
async function handleSessionUpdate(update: SessionUpdate): Promise<void>

// Handle permission requests
async function handlePermissionRequest(
  manager: WebSocketManager,
  requestId: string,
  permission: string
): Promise<void>

// Cleanup
async function destroySession(
  manager: WebSocketManager,
  sessionId: string
): Promise<void>
```

---

## Protocol Implementation Details

### JSON-RPC 2.0 Message Handler
```typescript
interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: any;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

// Message parsing and dispatching
class JsonRpcDispatcher {
  private pendingRequests: Map<string, {
    resolve: Function;
    reject: Function;
    timeout: NodeJS.Timeout;
  }>;

  // Send request and wait for response
  async request(method, params): Promise<any>

  // Handle incoming message
  handleMessage(message: JsonRpcMessage): void

  // Send response to server
  sendResponse(id, result, error?): void
}
```

### Authentication Implementation
```typescript
// Calculate Basic auth header
function createBasicAuthHeader(username: string, token: string): string {
  const credentials = `${username}:${token}`;
  const base64 = Buffer.from(credentials).toString('base64');
  return `Basic ${base64}`;
}

// WebSocket options with proper auth
const wsOptions = {
  headers: {
    'Authorization': createBasicAuthHeader(
      config.websocketUser,  // default: "token"
      config.websocketAuthToken
    )
  }
};
```

### Message Framing
```typescript
// Newline-delimited JSON
function encodeMessage(msg: JsonRpcMessage): string {
  return JSON.stringify(msg) + '\n';
}

// Buffered line reading
function createLineReader(socket: WebSocket): AsyncIterator<string> {
  let buffer = '';
  
  return {
    async next(): Promise<IteratorResult<string>> {
      // Find newline in buffer
      // If found, return line and update buffer
      // If not found, await new data and continue
    }
  };
}
```

---

## Implementation Phases

### Phase 3.1: WebSocket Manager Core
**Timeline**: 1-2 days
**Tasks**:
- [ ] Create `WebSocketManager` class with connect/disconnect
- [ ] Implement JSON-RPC message framing (stringify + newline)
- [ ] Implement line-based message parsing
- [ ] Implement request ID tracking and response matching
- [ ] Add timeout handling for requests
- [ ] Unit tests for message serialization/deserialization

**Testing**:
```
npm test -- websocketManager.test.ts
```

### Phase 3.2: Authentication & Initialization
**Timeline**: 1-2 days
**Tasks**:
- [ ] Implement Basic auth header calculation
- [ ] Connect to backend with auth header
- [ ] Send initialize request
- [ ] Handle initialize response
- [ ] Extract and store protocolVersion, authMethods, capabilities
- [ ] Unit tests for auth flow

**Testing**:
```
npm run dev
# Monitor console for: "Backend initialized with protocolVersion: 1"
```

### Phase 3.3: Session Lifecycle
**Timeline**: 2-3 days
**Tasks**:
- [ ] Update SessionStore schema with all required fields
- [ ] Implement session/new for creating new sessions
- [ ] Implement session/load for resuming by ID
- [ ] Implement fallback: session/resume for partial recovery
- [ ] Implement session/set_config_option for agent configuration
- [ ] Handle session creation/resumption in message handler
- [ ] Unit tests for session lifecycle

**Testing**:
```
# Send first message from new user
# Verify: session/new is called, sessionId is stored

# Send message from same user after bot restart
# Verify: session/load or session/resume is called
```

### Phase 3.4: Message Send & Streaming
**Timeline**: 2-3 days
**Tasks**:
- [ ] Implement session/prompt method
- [ ] Handle streaming responses via session/update
- [ ] Buffer and aggregate text chunks
- [ ] Send complete response to user
- [ ] Handle stopReason from backend
- [ ] Unit tests for message flow

**Testing**:
```
# Send prompt through bot
# Verify: session/prompt is called
# Verify: session/update messages are handled
# Verify: complete response is returned to user
```

### Phase 3.5: Permission Handling & Errors
**Timeline**: 1-2 days
**Tasks**:
- [ ] Handle session/request_permission callbacks
- [ ] Implement auto-approve/deny strategy (configurable)
- [ ] Implement JSON-RPC error responses
- [ ] Handle -32601 (method not found) gracefully
- [ ] Add retry logic for transient failures
- [ ] Unit tests for error paths

**Testing**:
```
# Trigger permission request from backend
# Verify: appropriate response is sent
# Verify: error responses follow JSON-RPC format
```

### Phase 3.6: Session Cleanup & Reconnection
**Timeline**: 1-2 days
**Tasks**:
- [ ] Implement session/destroy on cleanup
- [ ] Add reconnection logic for dropped connections
- [ ] Implement backoff retry strategy
- [ ] Handle graceful degradation
- [ ] Add logging/monitoring for session lifecycle
- [ ] Integration tests

**Testing**:
```
docker-compose up -d
# Kill backend: docker ps | grep backend | kill
# Verify: bot handles gracefully
# Restart backend: docker-compose up -d
# Verify: bot reconnects
```

---

## Data Flow Diagrams

### Message Flow
```
User → Bot (Teams) → /api/messages handler
                        ↓
                   Lookup conversation key
                   (channelId|conversationId|userId)
                        ↓
                   Get/Create session in SessionStore
                        ↓
                   WebSocket Manager.request("session/prompt")
                        ↓
                   Backend processes (sends session/update chunks)
                        ↓
                   Aggregate response text
                        ↓
                   Return to user ← Bot → Teams
```

### Session Lifecycle
```
First User Message:
  1. initialize()
  2. authenticate() [if needed]
  3. session/new() → get sessionId
  4. session/set_config_option(agent)
  5. session/prompt() → response
  6. Store sessionId in SessionStore

Subsequent Messages from Same User:
  1. Lookup sessionId in SessionStore
  2. session/load(sessionId) or session/resume(sessionId)
  3. session/set_config_option(agent) [if needed]
  4. session/prompt() → response

Session Recovery:
  1. If session/load fails → try session/resume
  2. If session/resume fails → create new session/new
  3. Log recovery method for debugging
```

### Permission Request Flow
```
Backend → session/request_permission
          {jsonrpc:"2.0", id:"X", method:"session/request_permission", params:{...}}
          ↓
Bot analyzes permission request
          ↓
          {jsonrpc:"2.0", id:"X", result:{outcome:{outcome:"approved|cancelled"}}}
          ↓
Backend receives response and continues
```

---

## Environment Configuration Updates

**New .env Variables**:
```
# WebSocket Authentication (from ask-acp-websocket.ps1)
WEBSOCKET_USER=token              # Default username for Basic auth
WEBSOCKET_AUTH_TOKEN={token}      # Authentication token

# Backend WebSocket
WEBSOCKET_URL=ws://backend:8080/ws

# Optional Authentication
ACP_AUTH_METHOD_ID={methodId}     # If backend requires specific auth method

# Session Configuration
ACP_AGENT_NAME=ACP-Chatbot        # Agent name to set in backend
SESSION_TIMEOUT_MS=300000         # 5 minutes
MAX_SESSION_AGE_MS=3600000        # 1 hour
```

---

## Testing Strategy

### Unit Tests
```typescript
// websocketManager.test.ts
- JSON-RPC message serialization
- Basic auth header generation
- Request/response ID matching
- Timeout handling
- Line-based parsing

// sessionStore.test.ts
- Session creation and lookup
- Session update
- Multiple concurrent conversations

// websocketBridge.test.ts
- initialize() flow
- authenticate() flow
- session/new(), session/load(), session/resume()
- session/prompt() with streaming
- Permission request handling
```

### Integration Tests
```
// With Docker backend
- Full initialize → prompt → response flow
- Multiple concurrent sessions
- Session resumption after disconnect
- Error recovery
- Streaming response aggregation
```

### Manual Tests
```
# Test 1: New conversation
1. Start bot container
2. Send message in Teams
3. Verify session is created
4. Check logs for sessionId

# Test 2: Session resumption
1. Send message 1
2. Restart bot container
3. Send message 2 from same user
4. Verify session is loaded/resumed
5. Conversation history maintained

# Test 3: Multiple users
1. Send from user A
2. Send from user B
3. Send from user A again
4. Verify separate sessions for each user

# Test 4: Backend failure
1. Stop backend service
2. Send message to bot
3. Verify graceful error response
4. Restart backend
5. Verify bot recovers
```

---

## Rollback Plan

If issues occur during Phase 3 implementation:

1. **Compilation errors**: Stay on current (working) commit
2. **Runtime errors**: Revert to docker image tag from Phase 2
3. **Protocol mismatch**: Roll back websocketBridge.ts changes
4. **Session issues**: Clear SessionStore and force new sessions

---

## Success Criteria

- [ ] All JSON-RPC 2.0 messages properly formatted
- [ ] Basic auth header correctly calculated
- [ ] initialize() response validated
- [ ] Sessions created and loaded correctly
- [ ] session/prompt() streaming responses aggregated
- [ ] session/update messages handled
- [ ] Permission requests responded to
- [ ] Error responses follow JSON-RPC format
- [ ] Session resumption working
- [ ] Graceful degradation for unsupported methods
- [ ] No memory leaks from WebSocket connections
- [ ] Timeouts properly enforced
- [ ] Reconnection logic functional
- [ ] All unit tests passing
- [ ] Integration tests passing
- [ ] Docker container builds successfully
- [ ] Health endpoint still returns 200 OK
- [ ] Message endpoint returns bot responses correctly

---

## References

- **PowerShell Script**: `ask-acp-websocket.ps1` (reference implementation)
- **Protocol Spec**: `WEBSOCKET_PROTOCOL_ANALYSIS.md` (detailed message formats)
- **Checklist**: `CHECKLIST.self-hosted.md` (Phase 3 items)
- **JSON-RPC 2.0 Spec**: https://www.jsonrpc.org/specification
