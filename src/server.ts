import express from "express";
import {
  ActivityTypes,
  CloudAdapter,
  ConfigurationBotFrameworkAuthentication,
  TurnContext
} from "botbuilder";
import { config } from "./config";
import { jwtAuthMiddleware } from "./jwtAuthMiddleware";
import { payloadLogger } from "./logger";
import { SessionStore } from "./sessionStore";
import { WebSocketManager } from "./websocketManager";
import { WebSocketSessionCoordinator } from "./websocketSessionCoordinator";

const app = express();
app.use(express.json());
app.use(payloadLogger);
const sessionStore = new SessionStore();

// Initialize WebSocket components
let wsManager: WebSocketManager | null = null;
let wsCoordinator: WebSocketSessionCoordinator | null = null;
let wsInitialized = false;

let adapter: CloudAdapter | null = null;

if (!config.jwtOnlyAuthEnabled) {
  const botFrameworkAuthentication = new ConfigurationBotFrameworkAuthentication(
    process.env as Record<string, string>
  );
  adapter = new CloudAdapter(botFrameworkAuthentication);

  adapter.onTurnError = async (context: TurnContext, err: Error) => {
    console.error("Unhandled bot error", err);
    await context.sendActivity("Something went wrong. Please try again.");
  };
}

type MessageRoutingInput = {
  channelId: string;
  conversationId: string;
  userId: string;
  userText: string;
};

async function routeMessageToBackend(input: MessageRoutingInput): Promise<{ text: string; stopReason: string }> {
  const conversationKey = `${input.channelId}|${input.conversationId}|${input.userId}`;

  if (!input.userText) {
    return {
      text: "Please send a message.",
      stopReason: "validation"
    };
  }

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
  const response = await wsCoordinator.sendMessage(conversationKey, sessionId, input.userText);

  // Format user-friendly response message
  let replyMessage = response.text;
  if (!replyMessage) {
    if (response.hasErrors) {
      replyMessage = `Error: ${response.error?.message || "Unknown error"}`;
    } else {
      replyMessage = `Response received (${response.stopReason})`;
    }
  }

  return {
    text: replyMessage,
    stopReason: response.stopReason
  };
}

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

app.use(jwtAuthMiddleware);

app.post("/api/messages", (req, res) => {
  if (config.jwtOnlyAuthEnabled) {
    const activity = req.body;

    if (!activity?.type) {
      res.status(400).json({ error: "Activity type is required" });
      return;
    }

    if (activity.type === "conversationUpdate") {
      console.log(`[JWT-ONLY] ConversationUpdate: ${activity.conversation?.id}`);
      res.status(200).json({ text: "Conversation updated" });
      return;
    }

    if (activity.type === "endOfConversation") {
      console.log(`[JWT-ONLY] EndOfConversation: ${activity.conversation?.id}`);
      res.status(200).json({ text: "Conversation ended" });
      return;
    }

    if (activity.type !== "message") {
      res.status(400).json({ error: `Unsupported activity type: ${activity.type}` });
      return;
    }

    const userText = (activity.text ?? "").trim();
    const channelId = activity.channelId ?? "msteams";
    const conversationId = activity.conversation?.id ?? "jwt-only-conversation";
    const userId = activity.from?.id ?? "jwt-only-user";

    routeMessageToBackend({ channelId, conversationId, userId, userText })
      .then((reply) => {
        res.status(200).json({ text: reply.text, stopReason: reply.stopReason });
      })
      .catch((error) => {
        console.error("[JWT-ONLY] Message endpoint error", {
          error,
          channelId,
          conversationId,
          userId
        });
        const message = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: message });
      });
    return;
  }

  if (!adapter) {
    res.status(500).json({ error: "CloudAdapter not initialized" });
    return;
  }

  adapter.process(req, res, async (context) => {
    if (context.activity.type !== ActivityTypes.Message) {
      return;
    }

    const channelId = context.activity.channelId ?? "unknown-channel";
    const conversationId = context.activity.conversation?.id ?? "unknown-conversation";
    const userId = context.activity.from?.id ?? "unknown-user";
    const userText = (context.activity.text ?? "").trim();

    try {
      const reply = await routeMessageToBackend({
        channelId,
        conversationId,
        userId,
        userText
      });

      await context.sendActivity(reply.text);
    } catch (error) {
      console.error("Backend communication failed", {
        error,
        channelId,
        conversationId,
        userId
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

// ─── Dev-only simulation endpoint (no Bot Framework auth) ───────────────────
// Enabled when NODE_ENV=development. Accepts a plain JSON body:
//   { "text": "...", "conversationId": "...", "userId": "...", "channelId": "..." }
// Returns: { "text": "..." }
// NOT available in production.
if (process.env.NODE_ENV === "development") {
  app.post("/api/simulate", async (req, res) => {
    const userText       = (req.body?.text ?? "").trim();
    const conversationId = (req.body?.conversationId ?? "sim-default").trim();
    const userId         = (req.body?.userId ?? "sim-user").trim();
    const channelId      = (req.body?.channelId ?? "simulation").trim();
    const conversationKey = `${channelId}|${conversationId}|${userId}`;

    if (!userText) {
      res.status(400).json({ error: "text is required" });
      return;
    }

    try {
      if (!wsInitialized) {
        await ensureWebSocketReady();
      }

      if (!wsCoordinator) {
        throw new Error("WebSocket coordinator not initialized");
      }

      const sessionId = await wsCoordinator.ensureSession(conversationKey);
      const response  = await wsCoordinator.sendMessage(conversationKey, sessionId, userText);

      let replyText = response.text;
      if (!replyText) {
        replyText = response.hasErrors
          ? `Error: ${response.error?.message ?? "Unknown error"}`
          : `(${response.stopReason})`;
      }

      res.status(200).json({ text: replyText, stopReason: response.stopReason });
    } catch (error) {
      console.error("Simulation endpoint error", { error, conversationKey });
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: message });
    }
  });

  // ─── Dev endpoint for full Bot Framework Activities (no JWT required) ──────────
  // Accepts complete Activity objects as sent by Teams (for realistic simulation)
  // Returns: { "text": "..." }
  app.post("/api/dev/messages", async (req, res) => {
    const activity = req.body;

    if (!activity?.type) {
      res.status(400).json({ error: "Activity type is required" });
      return;
    }

    // Handle ConversationUpdate (member join/leave)
    if (activity.type === "conversationUpdate") {
      console.log(`[DEV] ConversationUpdate: ${activity.conversation?.id}`);
      res.status(200).json({ text: "Conversation updated" });
      return;
    }

    // Handle EndOfConversation (close)
    if (activity.type === "endOfConversation") {
      console.log(`[DEV] EndOfConversation: ${activity.conversation?.id}`);
      res.status(200).json({ text: "Conversation ended" });
      return;
    }

    // Handle Message
    if (activity.type !== "message") {
      res.status(400).json({ error: `Unsupported activity type: ${activity.type}` });
      return;
    }

    const userText = (activity.text ?? "").trim();
    if (!userText) {
      res.status(400).json({ error: "Message text is required" });
      return;
    }

    const channelId    = activity.channelId ?? "msteams";
    const conversationId = activity.conversation?.id ?? "dev-conversation";
    const userId       = activity.from?.id ?? "dev-user";
    const conversationKey = `${channelId}|${conversationId}|${userId}`;

    try {
      if (!wsInitialized) {
        await ensureWebSocketReady();
      }

      if (!wsCoordinator) {
        throw new Error("WebSocket coordinator not initialized");
      }

      const sessionId = await wsCoordinator.ensureSession(conversationKey);
      const response  = await wsCoordinator.sendMessage(conversationKey, sessionId, userText);

      let replyText = response.text;
      if (!replyText) {
        replyText = response.hasErrors
          ? `Error: ${response.error?.message ?? "Unknown error"}`
          : `(${response.stopReason})`;
      }

      res.status(200).json({ text: replyText, stopReason: response.stopReason });
    } catch (error) {
      console.error("[DEV] Message endpoint error", { error, conversationKey });
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: message });
    }
  });

  console.log("DEV mode: full Activity endpoint enabled at POST /api/dev/messages");
}

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
