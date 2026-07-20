import { WebSocketManager } from "./websocketManager";
import { SessionStore, SessionRecord } from "./sessionStore";
import { StreamingResponseHandler } from "./streamingResponseHandler";
import { PermissionRequestManager } from "./permissionRequestManager";
import {
  InitializeResult,
  SessionNewResult,
  SessionLoadResult,
  SessionResumeResult,
  SessionConfigResult,
  SessionPromptResult,
  SessionUpdate,
  PermissionRequest
} from "./types/websocket";

/**
 * WebSocket Session Coordinator
 *
 * Manages the complete lifecycle of a backend session:
 * 1. Initialize protocol handshake
 * 2. Authentication (if required)
 * 3. Create/load/resume session
 * 4. Configure agent options
 * 5. Send prompts and receive responses
 * 6. Handle server-initiated messages
 */
export class WebSocketSessionCoordinator {
  private manager: WebSocketManager | null = null;
  private sessionStore: SessionStore;
  private permissionManager: PermissionRequestManager;
  private isInitialized: boolean = false;
  private protocolVersion: number = 1;
  private supportedAuthMethods: string[] = [];
  private responseHandlers: Map<string, StreamingResponseHandler> = new Map();
  private sessionToConversationMap: Map<string, string> = new Map(); // sessionId -> conversationKey
  private updateCallback?: (conversationKey: string, update: SessionUpdate) => void;
  private permissionCallback?: (conversationKey: string, request: PermissionRequest) => Promise<"approved" | "cancelled" | "denied">;

  constructor(sessionStore: SessionStore) {
    this.sessionStore = sessionStore;
    this.permissionManager = new PermissionRequestManager();
  }

  /**
   * Initialize connection and handshake with backend
   */
  async initialize(manager: WebSocketManager): Promise<void> {
    this.manager = manager;

    // Register event listeners for server-pushed messages
    this.manager.on("session/update", (update: SessionUpdate) => {
      // Route to active session's response handler if available
      for (const [conversationKey, handler] of this.responseHandlers.entries()) {
        handler.handleUpdate(update);
      }

      // Also call external callback if registered
      if (this.updateCallback) {
        // Note: without sessionId in the update, we route to all active handlers
        // In practice, only one should be active at a time
        this.updateCallback("", update);
      }
    });

    this.manager.on("session/request_permission", async (data: any) => {
      const requestId = data.id;
      const request: PermissionRequest = data.params;

      try {
        // Use permission manager to handle the request
        const outcome = await this.permissionManager.handlePermissionRequest(requestId, request);

        // Send response back to backend
        if (this.manager) {
          await this.manager.sendPermissionResponse(requestId, outcome);
        }
      } catch (error) {
        console.error("Permission request error:", error);
        // Send denial on error
        if (this.manager) {
          await this.manager.sendPermissionResponse(requestId, "denied");
        }
      }
    });

    // Run initialize handshake
    try {
      const result = await this.manager.initialize(this.protocolVersion);
      this.handleInitializeResult(result);
      this.isInitialized = true;
      console.log("WebSocket initialization successful");
    } catch (error) {
      console.error("WebSocket initialization failed:", error);
      throw error;
    }
  }

  /**
   * Handle initialize response
   */
  private handleInitializeResult(result: InitializeResult): void {
    this.protocolVersion = result.protocolVersion;
    this.supportedAuthMethods = result.authMethods?.map(m => m.id) || [];
  }

  /**
   * Create a new session for a conversation
   */
  async createSession(conversationKey: string, cwd: string = "/workspace"): Promise<string> {
    if (!this.manager || !this.isInitialized) {
      throw new Error("WebSocket not initialized");
    }

    try {
      // Ensure the conversation key exists in the store before we update it
      this.sessionStore.getOrCreate(conversationKey);

      const result = await this.manager.sessionNew(cwd);
      const sessionId = result.sessionId;

      // Update session store
      this.sessionStore.setSessionId(conversationKey, sessionId, "new");
      this.sessionStore.setCapabilities(conversationKey, {
        authMethods: this.supportedAuthMethods,
        loadSession: true,
        persistSession: false
      });

      console.log(`Session created: ${sessionId} for ${conversationKey}`);
      return sessionId;
    } catch (error) {
      this.sessionStore.setError(conversationKey, `Failed to create session: ${error}`);
      throw error;
    }
  }

  /**
   * Load an existing session
   */
  async loadSession(conversationKey: string, sessionId: string, cwd: string = "/workspace"): Promise<string> {
    if (!this.manager || !this.isInitialized) {
      throw new Error("WebSocket not initialized");
    }

    try {
      const result = await this.manager.sessionLoad(sessionId, cwd);

      // Update session store
      this.sessionStore.setSessionId(conversationKey, result.sessionId, "loaded");

      console.log(`Session loaded: ${result.sessionId} for ${conversationKey}`);
      return result.sessionId;
    } catch (error) {
      this.sessionStore.setError(conversationKey, `Failed to load session: ${error}`);
      throw error;
    }
  }

  /**
   * Resume an existing session
   */
  async resumeSession(conversationKey: string, sessionId: string): Promise<string> {
    if (!this.manager || !this.isInitialized) {
      throw new Error("WebSocket not initialized");
    }

    try {
      const result = await this.manager.sessionResume(sessionId);

      // Update session store
      this.sessionStore.setSessionId(conversationKey, result.sessionId, "resumed");

      console.log(`Session resumed: ${result.sessionId} for ${conversationKey}`);
      return result.sessionId;
    } catch (error) {
      this.sessionStore.setError(conversationKey, `Failed to resume session: ${error}`);
      throw error;
    }
  }

  /**
   * Configure session option
   */
  async configureSession(conversationKey: string, sessionId: string, configId: string, value: string): Promise<void> {
    if (!this.manager || !this.isInitialized) {
      throw new Error("WebSocket not initialized");
    }

    try {
      await this.manager.setConfigOption(sessionId, configId, value);
      console.log(`Session ${sessionId} configured: ${configId} = ${value}`);
    } catch (error) {
      this.sessionStore.setError(conversationKey, `Failed to configure session: ${error}`);
      throw error;
    }
  }

  /**
   * Send user message to session and get response
   */
  async sendMessage(conversationKey: string, sessionId: string, userMessage: string): Promise<{
    text: string;
    stopReason: string;
    hasErrors: boolean;
    error?: { code: string; message: string };
  }> {
    if (!this.manager || !this.isInitialized) {
      throw new Error("WebSocket not initialized");
    }

    try {
      const session = this.sessionStore.get(conversationKey);
      if (!session) {
        throw new Error(`Session not found: ${conversationKey}`);
      }

      if (session.sessionState !== "ready") {
        throw new Error(`Session not ready: state=${session.sessionState}`);
      }

      // Get or create response handler for this conversation
      let handler = this.responseHandlers.get(conversationKey);
      if (!handler) {
        handler = new StreamingResponseHandler();
        this.responseHandlers.set(conversationKey, handler);
      }

      // Reset handler for new message
      handler.reset();

      // Send prompt and wait for response (session/update messages arrive during this call)
      const result = await this.manager.sessionPrompt(sessionId, userMessage);

      // Get buffered response
      const response = handler.getResponse();

      // Clean up handler after getting response
      if (response.text.length === 0) {
        this.responseHandlers.delete(conversationKey);
      }

      // Update session state based on result
      if (result.stopReason === "error") {
        this.sessionStore.setError(conversationKey, `Prompt error: ${result.exitCode}`);
        return {
          text: response.text || `Backend error (exit code: ${result.exitCode})`,
          stopReason: "error",
          hasErrors: true,
          error: response.errors.length > 0 ? response.errors[0] : undefined
        };
      }

      return {
        text: response.text,
        stopReason: result.stopReason,
        hasErrors: response.errors.length > 0,
        error: response.errors.length > 0 ? response.errors[0] : undefined
      };
    } catch (error) {
      this.sessionStore.setError(conversationKey, `Failed to send message: ${error}`);
      throw error;
    }
  }

  /**
   * Get or ensure session is initialized for a conversation
   */
  async ensureSession(conversationKey: string): Promise<string> {
    const session = this.sessionStore.get(conversationKey);

    // Session already initialized and ready
    if (session?.sessionId && session.sessionState === "ready") {
      return session.sessionId;
    }

    // Session exists but failed - try to clean up and create new
    if (session && session.sessionState === "error") {
      try {
        if (session.sessionId) {
          await this.manager?.sessionDestroy(session.sessionId);
        }
      } catch (e) {
        // Ignore cleanup errors
      }
      this.sessionStore.getOrCreate(conversationKey); // Reset to new state
    }

    // Create new session
    if (!session || session.sessionState === "new") {
      return this.createSession(conversationKey);
    }

    throw new Error(`Unexpected session state: ${session.sessionState}`);
  }

  /**
   * Cleanup: destroy session on backend
   */
  async destroySession(conversationKey: string): Promise<void> {
    const session = this.sessionStore.get(conversationKey);
    if (!session?.sessionId || !this.manager) {
      return;
    }

    try {
      await this.manager.sessionDestroy(session.sessionId);
      console.log(`Session destroyed: ${session.sessionId}`);
    } catch (error) {
      console.error(`Failed to destroy session ${session.sessionId}:`, error);
    }
  }

  /**
   * Register callback for permission requests
   * Callback will be invoked when backend requests a permission
   */
  onPermissionRequest(callback: (permission: PermissionRequest) => Promise<"approved" | "cancelled" | "denied">): void {
    this.permissionManager.setExternalHandler(callback);
  }

  /**
   * Get permission manager (for direct access if needed)
   */
  getPermissionManager(): PermissionRequestManager {
    return this.permissionManager;
  }

  /**
   * Check if coordinator is ready
   */
  isReady(): boolean {
    return this.isInitialized && this.manager?.isReady() === true;
  }

  /**
   * Disconnect and cleanup
   */
  async shutdown(): Promise<void> {
    if (this.manager) {
      await this.manager.disconnect();
      this.manager = null;
    }
    this.isInitialized = false;
  }

  /**
   * Get session info (for debugging)
   */
  getSessionInfo(conversationKey: string): SessionRecord | undefined {
    return this.sessionStore.get(conversationKey);
  }
}
