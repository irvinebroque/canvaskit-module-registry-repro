exports.artifactMarker = "CJS_VALIDATION_CYCLE_A";
exports.name = "a";

const cycleB = require("./cycle-b.js");

exports.nameFromB = cycleB.name;
exports.seenByB = cycleB.seen;
