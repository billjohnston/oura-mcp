import type { Request, Response, NextFunction } from "express";
import { isValidToken } from "./store.js";

export function requireBearerToken(serverUrl: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ") || !isValidToken(auth.slice(7))) {
      // RFC 9728: point the client at the resource metadata so it can discover
      // the authorization server and start the flow itself.
      res.setHeader(
        "WWW-Authenticate",
        `Bearer resource_metadata="${serverUrl}/.well-known/oauth-protected-resource"`
      );
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}
