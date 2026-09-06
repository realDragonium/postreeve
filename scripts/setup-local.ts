import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const environmentPath = resolve(".env");
const dataPath = resolve("data");

mkdirSync(dataPath, { recursive: true });

if (existsSync(environmentPath)) {
  console.info("Kept the existing .env file and ensured the data directory exists.");
  process.exit(0);
}

const masterKey = randomBytes(32).toString("base64");
const environment = [
  `POSTREEVE_MASTER_KEY=${masterKey}`,
  "POSTREEVE_DB_PATH=./data/postreeve.sqlite",
  "POSTREEVE_HOST=127.0.0.1",
  "POSTREEVE_MAX_ATTACHMENT_BYTES=26214400",
  "POSTREEVE_MAX_UPLOAD_BYTES=20971520",
  "POSTREEVE_MAX_MESSAGE_BYTES=26214400",
  "PORT=3000",
  "",
].join("\n");

writeFileSync(environmentPath, environment, { encoding: "utf8", flag: "wx", mode: 0o600 });
console.info("Created a private .env and local data directory. The encryption key was not printed.");
