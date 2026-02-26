const Keyv = require("keyv");
const db = new Keyv("sqlite://kswings.db");

module.exports = { db };
