/** Read the OpenClaw gateway auth token from the URL query string. */
export function gatewayToken(): string {
  return new URLSearchParams(window.location.search).get("token") ?? "";
}
