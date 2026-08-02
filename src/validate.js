import fixture, { named } from "cjs-validation-fixture";

export default {
  fetch() {
    return Response.json({
      defaultCall: fixture(),
      sentinel: fixture.sentinel,
      named: fixture.named,
      namedImport: named,
      dirname: fixture.dirname,
      filename: fixture.filename,
      child: fixture.child,
      cycle: fixture.cycle,
      builtin: fixture.builtin,
    });
  },
};
