import CanvasKitInit from "canvaskit-wasm";

export default {
  async fetch() {
    await CanvasKitInit();
    return new Response("CanvasKit loaded");
  },
};
