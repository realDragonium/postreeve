import { secureHeaders } from "hono/secure-headers";

export const postreeveSecureHeaders = secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    imgSrc: ["'self'", "data:", "blob:", "http:", "https:"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    scriptSrc: ["'self'"],
    connectSrc: ["'self'"],
    frameSrc: ["'none'"],
  },
  referrerPolicy: "no-referrer",
});
