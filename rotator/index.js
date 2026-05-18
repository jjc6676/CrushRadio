// Rotator Durable Object (stub — implemented in Task 4)
export class Rotator {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    return new Response("Rotator stub", { status: 200 });
  }
}
