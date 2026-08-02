const path = require("path");
const child = require("./child.js");
const cycle = require("./cycle-a.js");

module.exports = function fixtureDefault() {
  return "default-call";
};
module.exports.sentinel = "CJS_VALIDATION_SENTINEL";
module.exports.named = "named-export";
module.exports.dirname = path.basename(__dirname);
module.exports.filename = path.basename(__filename);
module.exports.child = child;
module.exports.cycle = `${cycle.name}:${cycle.nameFromB}:${cycle.seenByB}`;
module.exports.builtin = path.join("commonjs", "fixture");
