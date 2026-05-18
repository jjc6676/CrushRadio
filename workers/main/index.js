// Crush Radio — Main Worker (stub)
// Full routing added in Task 5
export { Rotator } from "../../rotator/index.js";

export default {
  async fetch(request, env) {
    return new Response("Crush Radio v1 — scaffolding complete", {
      headers: { "content-type": "text/plain" },
    });
  },
};
