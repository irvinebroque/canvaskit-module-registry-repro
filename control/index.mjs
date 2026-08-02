import control from "./module.cjs";

export default {
  fetch() {
    return Response.json(control);
  },
};
