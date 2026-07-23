You are working on an existing Dockerized proxy application that already runs correctly.

Task:
Add a new authentication gate/middleware layer that validates incoming Azure / Microsoft Entra / Bot Framework JWT bearer tokens before any request reaches the existing business logic.

Important security requirements:
1. The proxy must validate incoming JWTs using only Microsoft’s public signing keys / JWKS / OpenID metadata.
2. The proxy must NOT require a client secret.
3. The proxy must NOT use a hard-coded public certificate.
4. The proxy must NOT use a fixed certificate that could expire and require manual replacement.
5. The proxy must dynamically retrieve Microsoft public signing keys from the public JWKS endpoint and cache them.
6. The proxy must support key rotation by using the JWT header `kid` to find the matching public signing key.
7. The proxy must validate:
   - JWT signature
   - issuer `iss`
   - audience `aud`
   - expiration `exp`
   - not-before `nbf`, if present
   - algorithm should be RS256 or the expected Microsoft-supported asymmetric signing algorithm, not `none`
8. Reject missing, malformed, expired, unsigned, wrongly signed, wrong issuer, or wrong audience tokens with HTTP 401.
9. Do not call Microsoft Graph.
10. Do not require Azure App Registration API permissions.
11. Do not require an Enterprise Application permission setup only for JWT validation.
12. Do not store or use any Azure client secret.
13. Do not store or use any private key.

Expected environment variables:
Add support for these `.env` settings:

AZURE_TENANT_ID=<tenant-guid>
AZURE_EXPECTED_AUDIENCE=<expected-aud-value>
AZURE_TOKEN_VERSION=v2.0
JWT_AUTH_ENABLED=true
JWT_AUTH_REQUIRED_PATH_PREFIX=/api/messages

Optional settings:
JWKS_CACHE_TTL_SECONDS=3600
JWT_CLOCK_SKEW_SECONDS=300
JWT_ALLOWED_ISSUERS=https://login.microsoftonline.com/<tenant-guid>/v2.0,https://sts.windows.net/<tenant-guid>/
JWT_AUTH_HEADER=Authorization

Issuer / metadata logic:
If AZURE_TOKEN_VERSION is v2.0, discover OpenID metadata from:

https://login.microsoftonline.com/${AZURE_TENANT_ID}/v2.0/.well-known/openid-configuration

Read `jwks_uri` from that metadata document and use it to fetch signing keys.

Expected issuer should normally be:

https://login.microsoftonline.com/${AZURE_TENANT_ID}/v2.0

However, allow JWT_ALLOWED_ISSUERS to override or include multiple accepted issuers because some Microsoft/Bot Framework tokens may use different issuer formats.

Audience logic:
Validate that the JWT `aud` claim exactly matches AZURE_EXPECTED_AUDIENCE.

The expected audience may be one of these depending on the upstream token:
- The Azure Bot App Registration / Microsoft App ID GUID
- api://<app-client-id>
- another exact audience value provided in the .env file

Do not guess the audience. Make it configurable through AZURE_EXPECTED_AUDIENCE.

Middleware behavior:
1. Only apply JWT validation if JWT_AUTH_ENABLED=true.
2. Only enforce it for routes starting with JWT_AUTH_REQUIRED_PATH_PREFIX.
3. Read the Authorization header.
4. Require format:

Authorization: Bearer <jwt>

5. Validate the JWT.
6. If valid, attach decoded claims to the request context using a safe property such as:
   - req.auth
   - request.state.auth
   - ctx.auth
   depending on the framework.
7. Continue to the existing proxy logic.
8. If invalid, return:

HTTP 401
{
  "error": "unauthorized",
  "message": "Invalid or missing bearer token"
}

Do not leak detailed validation errors to external callers. Log detailed errors internally only.

Implementation requirements:
- Use a mature JWT validation library appropriate for the existing project language/framework.
- Use OpenID discovery and JWKS validation if the library supports it.
- Cache JWKS keys in memory.
- Refresh JWKS automatically when:
  - cache expires
  - token `kid` is not found in current cache
- Do not fetch JWKS on every request.
- Add structured logs for:
  - missing token
  - invalid token
  - expired token
  - wrong issuer
  - wrong audience
  - unknown kid
  - successful validation, without logging the full JWT
- Never log the full bearer token.
- Never log secrets.

Docker / deployment requirements:
1. Update `.env.example`.
2. Update README with the required settings.
3. Make sure the Docker container loads environment variables correctly.
4. Add a basic health check route that does not require JWT, for example:

GET /healthz

returns:

200 OK
{
  "status": "ok"
}

5. Do not protect /healthz with JWT.
6. Existing functionality must continue to work after valid JWT validation.

Testing requirements:
Add tests or manual test examples for:

1. No Authorization header -> 401
2. Authorization header not starting with Bearer -> 401
3. Malformed JWT -> 401
4. Expired JWT -> 401
5. Wrong audience -> 401
6. Wrong issuer -> 401
7. Valid JWT -> request reaches existing proxy logic
8. /healthz -> 200 without JWT

Add curl examples:

curl -i https://your-proxy.example.com/healthz

curl -i https://your-proxy.example.com/api/messages \
  -H "Authorization: Bearer <valid-azure-jwt>" \
  -H "Content-Type: application/json" \
  -d '{}'

Important conceptual note:
This layer is only verifying an incoming JWT that was already issued by Microsoft. It does not acquire tokens. It does not need a client secret. It does not need certificate credentials. It does not need app permissions. It only needs:
- tenant ID
- expected audience
- expected issuer
- Microsoft public JWKS keys discovered from the public OpenID configuration endpoint.

Please inspect the existing codebase first, identify the framework, then implement the smallest clean middleware/gate layer that satisfies the above requirements.