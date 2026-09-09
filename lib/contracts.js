"use strict";

const fs = require("node:fs");
const path = require("node:path");

function artifact(name) {
  const file = path.resolve(__dirname, "..", "artifacts", `${name}.json`);
  if (!fs.existsSync(file)) throw new Error(`Missing ${name} artifact; run npm run compile`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

module.exports = { artifact };
