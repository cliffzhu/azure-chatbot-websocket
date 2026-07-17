import express from "express";
import {
  ActivityTypes,
  CloudAdapter,
  ConfigurationBotFrameworkAuthentication,
  TurnContext
} from "botbuilder";
import { config } from "./config";
import { SessionStore } from "./sessionStore";
import { WebSocketManager } from "./websocketManager";
import { WebSocketSessionCoordinator } from "./websocketSessionCoordinator";

const app = express();
const sessionStore = new SessionStore();

// Initialize WebSocket components
let wsManager: WebSocketManager | null = null;
let wsCoordinator: WebSocketSessionCoordinator | null = null;
let wsInitialized = false;

const botFrameworkAuthentication = new ConfigurationBotFrameworkAuthentication(
  process.env as Record<string, string>
);
const adapter = new CloudAdapter(botFrameworkAuthentication);

adapter.onTurnError = async (context: TurnContext, err: Error) => {
  console.error("Unhandled bot error", err);
  await context.sendActivity("Something went wrong. Please try again.");
};

/**
 * Initialize WebSocket connection on first use
 */
async function ensureWebSocketReady(): Promise<void> {
  if (wsInitialized) {
    return;
  }

  try {
    wsManager = new WebSocketManager({
      url: config.websocketUrl,
      username: config.websocketUser,
      authToken: config.websocketAuthToken,
      connectTimeoutMs: config.websocketConnectTimeoutMs
    });

    wsCoordinator = new WebSocketSessionCoordinator(sessionStore);

    // Register permission request handler
    // For now, deny all permission requests by default (secure approach)
    // In production, this could integrate with Teams to prompt the user
    wsCoordinator.onPermissionRequest(async (request) => {
      console.log(`Permission requested: ${request.permission}`);
      console.log(`Description: ${request.description || "(none)"}`);

      // Deny by default for security
      // This can be customized to approve specific permissions or integrate with user UI
      return "denied";
    });

    // Connect and initialize
    await wsManager.connect();
    await wsCoordinator.initialize(wsManager);

    wsInitialized = true;
    console.log("WebSocket coordinator initialized and ready");
  } catch (error) {
    console.error("Failed to initialize WebSocket coordinator:", error);
    wsInitialized = false;
    wsManager = null;
    wsCoordinator = null;
    throw error;
  }
}

app.get(config.healthEndpointPath, (_req, res) => {
  res.status(200).json({
    status: "ok",
    sessionsInMemory: sessionStore.size(),
    wsReady: wsCoordinator?.isReady() ?? false
  });
});

app.post("/api/messages", (req, res) => {
  adapter.process(req, res, async (context) => {
    if (context.activity.type !== ActivityTypes.Message) {
      return;
    }

    const channelId = context.activity.channelId ?? "unknown-channel";
    const conversationId = context.activity.conversation?.id ?? "unknown-conversation";
    const userId = context.activity.from?.id ?? "unknown-user";
    const userText = (context.activity.text ?? "").trim();

    const conversationKey = `${channelId}|${conversationId}|${userId}`;

    if (!userText) {
      await context.sendActivity("Please send a message.");
      return;
    }

    try {
      // Ensure WebSocket is ready
      if (!wsInitialized) {
        await ensureWebSocketReady();
      }

      if (!wsCoordinator) {
        throw new Error("WebSocket coordinator not initialized");
      }

      // Ensure session exists for this conversation
      const sessionId = await wsCoordinator.ensureSession(conversationKey);

      // Send message to backend and get buffered response
      const response = await wsCoordinator.sendMessage(conversationKey, sessionId, userText);

      // Format user-friendly response message
      let replyMessage = response.text;
      if (!replyMessage) {
        if (response.hasErrors) {
          replyMessage = `Error: ${response.error?.message || "Unknown error"}`;
        } else {
          replyMessage = `Response received (${response.stopReason})`;
        }
      }

      await context.sendActivity(replyMessage);
    } catch (error) {
      console.error("Backend communication failed", {
        error,
        conversationKey
      });

      // Determine error message
      let errorMessage = "I cannot reach the backend service right now. Please try again shortly.";
      if (error instanceof Error) {
        if (error.message.includes("timeout")) {
          errorMessage = "The backend service is not responding. Please try again.";
        } else if (error.message.includes("not initialized")) {
          errorMessage = "Service initialization failed. Please try again.";
        }
      }

      await context.sendActivity(errorMessage);
    }
  });
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("SIGTERM received, shutting down gracefully...");
  if (wsCoordinator) {
    // Cancel any pending permission requests
    const permMgr = wsCoordinator.getPermissionManager();
    permMgr.cancelAllRequests();

    await wsCoordinator.shutdown();
  }
  process.exit(0);
});

app.listen(config.port, () => {
  console.log(`Bot runtime listening on port ${config.port}`);
});
