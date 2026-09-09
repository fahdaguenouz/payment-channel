"use strict";

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { getBytes, solidityPackedKeccak256 } = require("ethers");

function parseOptions(argv, defaults = {}) {
  const result = { _: [], ...defaults };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      result._.push(arg);
      continue;
    }
    const name = arg.slice(2).toLowerCase();
    if (name === "help") result.help = true;
    else {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      result[name] = argv[++i];
    }
  }
  return result;
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

function writeJson(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, mode);
}

function stateDigest(nonce, balanceA, balanceB) {
  return solidityPackedKeccak256(
    ["uint256", "uint256", "uint256"],
    [BigInt(nonce), BigInt(balanceA), BigInt(balanceB)]
  );
}

async function signState(wallet, state) {
  return wallet.signMessage(getBytes(stateDigest(state.nonce, state.balanceA, state.balanceB)));
}

function normalizePeer(value) {
  const withScheme = /^https?:\/\//i.test(value) ? value : `http://${value}`;
  const url = new URL(withScheme);
  if (!url.port) throw new Error("Peer must include a port (for example 127.0.0.1:2002)");
  return url.origin;
}

async function requestJson(url, options = {}) {
  const target = new URL(url);
  const body = options.body === undefined ? null : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const request = http.request(target, {
      method: options.method || (body ? "POST" : "GET"),
      timeout: options.timeout || 10_000,
      headers: body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}
    }, (response) => {
      let data = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        data += chunk;
        if (data.length > 1_000_000) request.destroy(new Error("Response too large"));
      });
      response.on("end", () => {
        let parsed;
        try { parsed = data ? JSON.parse(data) : {}; }
        catch { return reject(new Error(`Invalid response from ${target.origin}`)); }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          return reject(new Error(parsed.error || `HTTP ${response.statusCode}`));
        }
        resolve(parsed);
      });
    });
    request.on("timeout", () => request.destroy(new Error(`Timed out contacting ${target.origin}`)));
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) request.destroy(new Error("Request too large"));
    });
    request.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error("Request body must be valid JSON")); }
    });
    request.on("error", reject);
  });
}

function jsonResponse(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

module.exports = {
  jsonResponse,
  normalizePeer,
  parseOptions,
  readJson,
  readRequestBody,
  requestJson,
  signState,
  stateDigest,
  writeJson
};
