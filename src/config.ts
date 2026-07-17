import dotenv from "dotenv";

dotenv.config();

type AppConfig = {
  port: number;
  logLevel: string;
  websocketUser: string;
  websocketAuthToken: string;
  websocketUrl: string;
  websocketConnectTimeoutMs: number;
  healthEndpointPath: string;
};

function mustGet(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function asNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be a number`);
  }
  return parsed;
}

export const config: AppConfig = {
  port: asNumber("PORT", 3978),
  logLevel: process.env.LOG_LEVEL ?? "info",
  websocketUser: process.env.WEBSOCKET_USER ?? "token",
  websocketAuthToken: mustGet("WEBSOCKET_AUTH_TOKEN"),
  websocketUrl: mustGet("WEBSOCKET_URL"),
  websocketConnectTimeoutMs: asNumber("WEBSOCKET_CONNECT_TIMEOUT_MS", 10_000),
  healthEndpointPath: process.env.HEALTH_ENDPOINT_PATH ?? "/healthz"
};
