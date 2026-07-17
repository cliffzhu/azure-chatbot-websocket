# azure-chatbot-websocket
A self-hosted container bot service that connects Microsoft Teams (via Azure AI Bot Service) to a websocket backend.

## Overview
This guide explains how to deploy and operate the bot after the application is ready.

- Azure AI Bot Service is used for Teams channel registration and routing.
- Bot runtime is self-hosted in your container environment.
- Bot endpoint must be HTTPS and publicly reachable.

## Prerequisites
- A running container host (VM, Kubernetes, or on-prem Docker host).
- A public DNS name and TLS certificate for the bot endpoint.
- Azure CLI installed and logged in.
- Existing Azure AI Bot Service resource.
- Docker and Docker Compose installed locally.
- Git installed for cloning the repository.

## Quick Start

### 1. Clone the Repository

```powershell
git clone https://github.com/cliffzhu/azure-chatbot-websocket.git
cd azure-chatbot-websocket
```

### 2. Configure Environment Variables

```powershell
# Copy the sample environment file
Copy-Item .env.sample .env

# Edit .env with your settings
notepad .env
```

Required environment variables:
```env
# WebSocket Backend Configuration
WEBSOCKET_URL=ws://your-backend:8080/ws
WEBSOCKET_USER=token
WEBSOCKET_AUTH_TOKEN=your_auth_token_here

# Teams Bot Configuration
MicrosoftAppType=SingleTenant
MicrosoftAppId=your_app_id
MicrosoftAppPassword=your_app_password
MicrosoftAppTenantId=your_tenant_id

# Connection Timeouts
WEBSOCKET_CONNECT_TIMEOUT_MS=10000
WEBSOCKET_MESSAGE_TIMEOUT_MS=30000
```

### 3. Start Docker Container

```powershell
# Build and start the container with Docker Compose
docker-compose up -d --build

# View logs
docker-compose logs -f

# Verify the bot is running (health check)
curl http://localhost:3978/healthz

# Stop the container
docker-compose down
```

## Deployment Checklist
Use the deployment checklist for production cutover and validation:

- CHECKLIST.self-hosted.md

## Verify Azure Resource Baseline
Run the verification script before deployment:

```powershell
./scripts/verify-azure-resources.ps1
```

This confirms:
- Azure account context
- Resource group availability
- Existing resources in the resource group
- Current Azure AI Bot Service endpoint

## Deploy Bot Runtime
### Build Container Image

```powershell
docker build -t azure-chatbot-websocket:local .
```

### Run Locally With Compose

```powershell
docker compose up -d --build
```

### Verify Local Runtime

```powershell
curl http://localhost:3978/healthz
```

After local verification succeeds:

1. Deploy your bot container to your hosting environment.
2. Expose an HTTPS endpoint for bot messages, for example:
	- https://bot.company.com/api/messages
3. Confirm health probe endpoint is reachable, for example:
	- https://bot.company.com/healthz

## Cut Over Azure AI Bot Service Endpoint
After your self-hosted endpoint is verified, update Azure AI Bot Service:

```powershell
./scripts/update-bot-endpoint.ps1 -NewEndpoint "https://bot.company.com/api/messages"
```

## Post-Deployment Validation
1. Send a Teams test message and confirm bot response.
2. Validate websocket backend round-trip behavior.
3. Confirm logs contain correlation IDs and no secret leakage.
4. Keep rollback endpoint ready until smoke tests pass.


