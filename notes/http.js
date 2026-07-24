"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");

const BODY_LIMIT = 1024 * 1024;

class HttpError extends Error {
  constructor(status, message, code = "request_error") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function parseCookies(header = "") {
  const cookies = {};
  for (const item of header.split(";")) {
    const index = item.indexOf("=");
    if (index === -1) continue;
    const name = item.slice(0, index).trim();
    const value = item.slice(index + 1).trim();
    if (name) cookies[name] = value;
  }
  return cookies;
}

async function readJson(req) {
  const type = (req.headers["content-type"] || "").split(";")[0].trim();
  if (type !== "application/json") {
    throw new HttpError(415, "Content-Type deve ser application/json.");
  }

  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new HttpError(413, "Requisição muito grande.");
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "JSON inválido.");
  }
}

function securityHeaders(res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data:; connect-src 'self'; object-src 'none'; " +
      "base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
  );
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.end(body);
}

function sendFile(res, filename, contentType) {
  const body = fs.readFileSync(filename);
  res.statusCode = 200;
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Length", body.length);
  res.end(body);
}

function loadSecret(fileVariable, valueVariable) {
  const filename = process.env[fileVariable];
  if (filename) return fs.readFileSync(filename, "utf8").trim();
  return (process.env[valueVariable] || "").trim();
}

function safeEqualText(actual, expected) {
  const left = crypto.createHash("sha256").update(actual || "", "utf8").digest();
  const right = crypto.createHash("sha256").update(expected || "", "utf8").digest();
  return crypto.timingSafeEqual(left, right);
}

module.exports = {
  HttpError,
  loadSecret,
  parseCookies,
  readJson,
  safeEqualText,
  securityHeaders,
  sendFile,
  sendJson
};
