exports.artifactMarker = "CJS_VALIDATION_CYCLE_B";
exports.name = "b";

const cycleA = require("./cycle-a.js");

exports.seen = cycleA.name;
