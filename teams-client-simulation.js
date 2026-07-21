#!/usr/bin/env node

"use strict";

const readline = require("node:readline/promises");
const { stdin, stdout, exit } = require("node:process");
const { randomUUID } = require("node:crypto");

function parseArgs(argv) {
  const options = {
    botUrl: "http://localhost:3978",
    channelId: "msteams",
    userId: "sim-user-001",
    userName: "Simulated User",
    userAADId: "12345678-1234-1234-1234-123456789012",
    conversationId: "",
    tenantId: "9cbd3073-3291-419c-ad86-3dd8860cad5f",
    botId: "28:d4c09dd1-ab88-4b8c-9a98-3199b8519fb8",
    botName: "ACP Bot",
    question: "",
    verbose: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--verbose") {
      options.verbose = true;
      continue;
    }

    if (!arg.startsWith("--")) {
      continue;
    }

    const key = arg.slice(2);
    const value = argv[i + 1];
    if (typeof value === "undefined" || value.startsWith("--")) {
      throw new Error(`Missing value for argument: ${arg}`);
    }

    i += 1;

    switch (key) {
      case "bot-url":
        options.botUrl = value;
        break;
      case "channel-id":
        options.channelId = value;
        break;
      case "user-id":
        options.userId = value;
        break;
      case "user-name":
        options.userName = value;
        break;
      case "user-aad-id":
        options.userAADId = value;
        break;
      case "conversation-id":
        options.conversationId = value;
        break;
      case "tenant-id":
        options.tenantId = value;
        break;
      case "bot-id":
        options.botId = value;
        break;
      case "bot-name":
        options.botName = value;
        break;
      case "question":
        options.question = value;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function generateConversationId() {
  return `19:room-${randomUUID().replace(/-/g, "").slice(0, 12)}@thread.skype`;
}

function newBotFrameworkActivity(options, type = "message", text = "") {
  const activity = {
    type,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    localTimestamp: new Date().toISOString(),
    serviceUrl: "https://smba.trafficmanager.net/amer/",
    channelId: options.channelId,
    from: {
      id: options.userId,
      name: options.userName,
      aadObjectId: options.userAADId
    },
    conversation: {
      id: options.conversationId,
      isGroup: false,
      conversationType: "personal",
      tenantId: options.tenantId
    },
    recipient: {
      id: options.botId,
      name: options.botName
    },
    textFormat: "plain",
    locale: "en-US",
    channelData: {
      teamsChannelId: options.conversationId,
      teamsTeamId: "19:team@thread.skype",
      tenant: {
        id: options.tenantId
      }
    }
  };

  if (type === "message" && text && text.trim().length > 0) {
    activity.text = text;
  }

  return activity;
}

async function sendBotActivity(devMessagesEndpoint, activity, verbose) {
  const body = JSON.stringify(activity);

  if (verbose) {
    console.log(`[DEBUG] POST ${devMessagesEndpoint}`);
    console.log(`[DEBUG] Body: ${body}`);
  }

  const response = await fetch(devMessagesEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body
  });

  const contentType = response.headers.get("content-type") || "";
  const isJson = contentType.includes("application/json");
  const responseBody = isJson ? await response.json() : await response.text();

  if (!response.ok) {
    const details = typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody);
    throw new Error(`HTTP ${response.status}: ${details}`);
  }

  return {
    statusCode: response.status,
    body: responseBody
  };
}

async function getHealth(healthEndpoint) {
  const response = await fetch(healthEndpoint);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

function printBanner(options) {
  console.log("------------------------------------------");
  console.log(" Teams Client Simulation (Full Activity)");
  console.log(` Bot URL        : ${options.botUrl}`);
  console.log(` Channel        : ${options.channelId}`);
  console.log(` Conversation   : ${options.conversationId}`);
  console.log(` User           : ${options.userName} (${options.userId})`);
  console.log("------------------------------------------");
  console.log("");
}

function printResponse(payload) {
  if (!payload) {
    console.log("(no response body)");
    return;
  }

  if (typeof payload === "object" && payload.text) {
    console.log(payload.text);
    return;
  }

  if (typeof payload === "string") {
    console.log(payload);
    return;
  }

  console.log(JSON.stringify(payload));
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`Argument error: ${error.message}`);
    console.error("Example: node teams-client-simulation.js --question \"hello\" --verbose");
    exit(2);
    return;
  }

  const interactive = !options.question || options.question.trim().length === 0;
  if (!options.conversationId || options.conversationId.trim().length === 0) {
    options.conversationId = generateConversationId();
  }

  const devMessagesEndpoint = `${options.botUrl}/api/dev/messages`;
  const healthEndpoint = `${options.botUrl}/healthz`;

  printBanner(options);

  console.log("Checking bot health...");
  try {
    const health = await getHealth(healthEndpoint);
    const wsStatus = health.wsReady ? "connected" : "not connected";
    console.log(`  status   : ${health.status}`);
    console.log(`  wsReady  : ${wsStatus}`);
    console.log(`  sessions : ${health.sessionsInMemory} in memory`);
  } catch (error) {
    console.error(`  Health check FAILED: ${error.message}`);
    console.error(`  Is the bot running at ${options.botUrl} ?`);
    exit(1);
    return;
  }

  console.log("");
  console.log("Sending initial conversationUpdate...");
  try {
    const initActivity = newBotFrameworkActivity(options, "conversationUpdate");
    await sendBotActivity(devMessagesEndpoint, initActivity, options.verbose);
    console.log("  Conversation initialized");
  } catch (error) {
    console.warn(`  Warning: Failed to send conversationUpdate: ${error.message}`);
  }

  console.log("");
  if (!interactive) {
    const question = options.question.trim();
    console.log(`You  > ${question}`);

    try {
      const startedAt = Date.now();
      const activity = newBotFrameworkActivity(options, "message", question);
      const response = await sendBotActivity(devMessagesEndpoint, activity, options.verbose);
      const elapsedMs = Date.now() - startedAt;

      console.log(`Bot  > (HTTP ${response.statusCode}, ${elapsedMs}ms)`);
      printResponse(response.body);
      exit(0);
      return;
    } catch (error) {
      console.error(`ERROR: ${error.message}`);
      exit(1);
      return;
    }
  }

  console.log("Interactive mode - type messages or /close to end. Press Ctrl+C to force exit.");
  console.log("");

  let turn = 0;
  const rl = readline.createInterface({ input: stdin, output: stdout });

  try {
    while (true) {
      const input = (await rl.question("You  > ")).trim();
      if (!input) {
        continue;
      }

      if (input === "/close") {
        process.stdout.write("Bot  > ");
        try {
          const closeActivity = newBotFrameworkActivity(options, "endOfConversation");
          await sendBotActivity(devMessagesEndpoint, closeActivity, options.verbose);
          console.log("Conversation closed");
          console.log("");
          console.log("Session ended. Exiting.");
          break;
        } catch (error) {
          console.error(`ERROR: Failed to close conversation: ${error.message}`);
        }
        console.log("");
        continue;
      }

      turn += 1;
      process.stdout.write("Bot  > ");

      try {
        const startedAt = Date.now();
        const activity = newBotFrameworkActivity(options, "message", input);
        const response = await sendBotActivity(devMessagesEndpoint, activity, options.verbose);
        const elapsedMs = Date.now() - startedAt;

        printResponse(response.body);
        if (options.verbose) {
          console.log(`       [turn ${turn}, ${elapsedMs}ms, HTTP ${response.statusCode}]`);
        }
      } catch (error) {
        console.error(`ERROR: ${error.message}`);
      }

      console.log("");
    }
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(`Fatal error: ${error instanceof Error ? error.message : String(error)}`);
  exit(1);
});
