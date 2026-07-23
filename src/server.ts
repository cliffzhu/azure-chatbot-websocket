import express from "express";
import {
  Activity,
  ActivityTypes,
  CloudAdapter,
  ConfigurationBotFrameworkAuthentication,
  TurnContext
} from "botbuilder";
import { config } from "./config";
import { jwtAuthMiddleware } from "./jwtAuthMiddleware";
import { logOutgoingActivity, payloadLogger } from "./logger";
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
let wsConnectingPromise: Promise<void> | null = null;

let adapter: CloudAdapter | null = null;

const botFrameworkAuthentication = new ConfigurationBotFrameworkAuthentication(
  process.env as Record<string, string>
);
adapter = new CloudAdapter(botFrameworkAuthentication);

adapter.onTurnError = async (context: TurnContext, err: Error) => {
  console.error("Unhandled bot error", err);
  await sendActivityWithLog(
    context,
    "Something went wrong. Please try again.",
    "api/messages"
  );
};

type MessageRoutingInput = {
  channelId: string;
  conversationId: string;
  userId: string;
  userText: string;
};

const DISABLED_TOOLS_PREAMBLE = "Info: Disabled tools: apply_patch, bash, list_bash, read_bash, session_store_sql, sql, stop_bash, task, web_fetch, write_agent";

function sanitizeBackendReplyText(text: string): string {
  if (!text.startsWith(DISABLED_TOOLS_PREAMBLE)) {
    return text;
  }

  return text.slice(DISABLED_TOOLS_PREAMBLE.length).trimStart();
}

async function sendActivityWithLog(
  context: TurnContext,
  text: string,
  source: "api/messages" | "api/dev/messages",
  stopReason?: string
): Promise<void> {
  const channelId = context.activity.channelId ?? "unknown-channel";
  const conversationId = context.activity.conversation?.id ?? "unknown-conversation";
  const userId = context.activity.from?.id ?? "unknown-user";

  if (config.outgoingActivityLogEnabled) {
    console.info("[outgoing] sendActivity attempt", {
      source,
      channelId,
      conversationId,
      userId,
      textLength: text.length,
      stopReason: stopReason ?? "n/a"
    });

    logOutgoingActivity({
      source,
      channelId,
      conversationId,
      userId,
      status: "attempt",
      text,
      stopReason
    });
  }

  try {
    await context.sendActivity(text);
    if (config.outgoingActivityLogEnabled) {
      console.info("[outgoing] sendActivity success", {
        source,
        channelId,
        conversationId,
        userId,
        textLength: text.length,
        stopReason: stopReason ?? "n/a"
      });

      logOutgoingActivity({
        source,
        channelId,
        conversationId,
        userId,
        status: "success",
        text,
        stopReason
      });
    }
  } catch (error) {
    console.error("[outgoing] sendActivity failed", {
      source,
      channelId,
      conversationId,
      userId,
      textLength: text.length,
      stopReason: stopReason ?? "n/a",
      error
    });

    logOutgoingActivity({
      source,
      channelId,
      conversationId,
      userId,
      status: "failure",
      text,
      stopReason,
      error: error instanceof Error ? error.message : String(error)
    });

    throw error;
  }
}

async function sendJwtOnlyActivityWithLog(
  activity: Activity,
  text: string,
  source: "api/messages" | "api/dev/messages",
  stopReason?: string
): Promise<void> {
  const channelId = activity.channelId ?? "unknown-channel";
  const conversationId = activity.conversation?.id ?? "unknown-conversation";
  const userId = activity.from?.id ?? "unknown-user";

  if (config.outgoingActivityLogEnabled) {
    console.info("[outgoing] sendActivity attempt", {
      source,
      channelId,
      conversationId,
      userId,
      textLength: text.length,
      stopReason: stopReason ?? "n/a"
    });

    logOutgoingActivity({
      source,
      channelId,
      conversationId,
      userId,
      status: "attempt",
      text,
      stopReason
    });
  }

  if (!adapter) {
    throw new Error("CloudAdapter not initialized");
  }

  const botAppId = process.env.MicrosoftAppId ?? "";
  if (!botAppId) {
    throw new Error("MicrosoftAppId is required to send channel activities in JWT-only mode");
  }

  try {
    const reference = TurnContext.getConversationReference(activity);
    await adapter.continueConversationAsync(botAppId, reference, async (proactiveContext) => {
      await proactiveContext.sendActivity(text);
    });

    if (config.outgoingActivityLogEnabled) {
      console.info("[outgoing] sendActivity success", {
        source,
        channelId,
        conversationId,
        userId,
        textLength: text.length,
        stopReason: stopReason ?? "n/a"
      });

      logOutgoingActivity({
        source,
        channelId,
        conversationId,
        userId,
        status: "success",
        text,
        stopReason
      });
    }
  } catch (error) {
    console.error("[outgoing] sendActivity failed", {
      source,
      channelId,
      conversationId,
      userId,
      textLength: text.length,
      stopReason: stopReason ?? "n/a",
      error
    });

    logOutgoingActivity({
      source,
      channelId,
      conversationId,
      userId,
      status: "failure",
      text,
      stopReason,
      error: error instanceof Error ? error.message : String(error)
    });

    throw error;
  }
}

async function routeMessageToBackend(input: MessageRoutingInput): Promise<{ text: string; stopReason: string }> {
  const conversationKey = `${input.channelId}|${input.conversationId}|${input.userId}`;

  if (!input.userText) {
    return {
      text: "Please send a message.",
      stopReason: "validation"
    };
  }

  // Ensure WebSocket is ready and connected
  if (!wsInitialized || !wsCoordinator?.isReady()) {
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

  replyMessage = sanitizeBackendReplyText(replyMessage);

  return {
    text: replyMessage,
    stopReason: response.stopReason
  };
}

async function buildConversationReply(input: MessageRoutingInput): Promise<{ text: string; stopReason: string }> {
  return routeMessageToBackend(input);
}

async function sendStreamingTypingIndicators(context: TurnContext): Promise<() => void> {
  if (!config.streamingResponsesEnabled) {
    return () => {};
  }

  let active = true;

  const sendTyping = async () => {
    if (!active) {
      return;
    }

    try {
      await context.sendActivity({ type: ActivityTypes.Typing });
    } catch (error) {
      console.error("Failed to send typing indicator", error);
    }
  };

  await sendTyping();

  const interval = setInterval(() => {
    void sendTyping();
  }, 2500);

  return () => {
    active = false;
    clearInterval(interval);
  };
}

/**
 * Initialize or reconnect the WebSocket on demand.
 * Serialized via wsConnectingPromise so concurrent callers all wait for the same attempt.
 */
async function ensureWebSocketReady(): Promise<void> {
  // Already ready — fast path
  if (wsInitialized && wsCoordinator?.isReady()) {
    return;
  }

  // Serialize concurrent callers onto a single reconnect attempt
  if (wsConnectingPromise) {
    return wsConnectingPromise;
  }

  wsConnectingPromise = (async () => {
    try {
      if (wsInitialized && wsManager && wsCoordinator) {
        // Manager + coordinator already exist (background reconnect loop is active).
        // Short-circuit: connect immediately and re-run the handshake.
        console.log("WebSocket not ready — reconnecting on demand...");
        await wsManager.connect();
        await wsCoordinator.reInitializeHandshake();
        console.log("WebSocket reconnected on demand");
      } else {
        // First-time initialization
        wsManager = new WebSocketManager({
          url: config.websocketUrl,
          username: config.websocketUser,
          authToken: config.websocketAuthToken,
          connectTimeoutMs: config.websocketConnectTimeoutMs
        });

        wsCoordinator = new WebSocketSessionCoordinator(sessionStore);

        wsCoordinator.onPermissionRequest(async (request) => {
          console.log(`Permission requested: ${request.permission}`);
          console.log(`Description: ${request.description || "(none)"}`);
          return "denied";
        });

        await wsManager.connect();
        await wsCoordinator.initialize(wsManager);

        wsInitialized = true;
        console.log("WebSocket coordinator initialized and ready");
      }
    } catch (error) {
      console.error("Failed to initialize/reconnect WebSocket:", error);
      if (!wsInitialized) {
        // First-time failure — clean up so next attempt starts fresh
        wsManager = null;
        wsCoordinator = null;
      }
      throw error;
    } finally {
      wsConnectingPromise = null;
    }
  })();

  return wsConnectingPromise;
}

app.get(config.healthEndpointPath, (_req, res) => {
  res.status(200).json({
    status: "ok",
    sessionsInMemory: sessionStore.size(),
    wsReady: wsCoordinator?.isReady() ?? false
  });
});

app.use(jwtAuthMiddleware);

app.post("/api/messages", async (req, res) => {
  if (config.jwtOnlyAuthEnabled) {
    const activity = req.body as Activity;

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

    try {
      const reply = await routeMessageToBackend({ channelId, conversationId, userId, userText });
      await sendJwtOnlyActivityWithLog(activity, reply.text, "api/messages", reply.stopReason);
      // Acknowledge the incoming activity; the user-visible reply is sent as a channel activity.
      res.status(200).json({});
    } catch (error) {
      console.error("[JWT-ONLY] Message endpoint error", {
        error,
        channelId,
        conversationId,
        userId
      });

      let errorMessage = "I cannot reach the backend service right now. Please try again shortly.";
      if (error instanceof Error) {
        if (error.message.includes("timeout")) {
          errorMessage = "The backend service is not responding. Please try again.";
        } else if (error.message.includes("not initialized")) {
          errorMessage = "Service initialization failed. Please try again.";
        }
      }

      try {
        await sendJwtOnlyActivityWithLog(activity, errorMessage, "api/messages");
        res.status(200).json({});
      } catch (sendError) {
        const message = sendError instanceof Error ? sendError.message : String(sendError);
        res.status(500).json({ error: message });
      }
    }
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
    const stopStreamingIndicators = await sendStreamingTypingIndicators(context);

    try {
      const reply = await routeMessageToBackend({
        channelId,
        conversationId,
        userId,
        userText
      });

      await sendActivityWithLog(
        context,
        reply.text,
        "api/messages",
        reply.stopReason
      );
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

      await sendActivityWithLog(
        context,
        errorMessage,
        "api/messages"
      );
    } finally {
      stopStreamingIndicators();
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
      if (!wsInitialized || !wsCoordinator?.isReady()) {
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
      if (activity.type === "typing") {
        res.status(200).json({});
        return;
      }

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

    if (adapter) {
      adapter.process(req, res, async (context) => {
        if (context.activity.type !== ActivityTypes.Message) {
          return;
        }

        const stopStreamingIndicators = await sendStreamingTypingIndicators(context);

        try {
          const reply = await buildConversationReply({
            channelId,
            conversationId,
            userId,
            userText
          });

          await sendActivityWithLog(
            context,
            reply.text,
            "api/dev/messages",
            reply.stopReason
          );
        } catch (error) {
          console.error("[DEV] Message endpoint error", {
            error,
            conversationKey
          });

          const message = error instanceof Error ? error.message : String(error);
          await sendActivityWithLog(
            context,
            message,
            "api/dev/messages"
          );
        } finally {
          stopStreamingIndicators();
        }
      });
      return;
    }

    try {
      if (!wsInitialized || !wsCoordinator?.isReady()) {
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
