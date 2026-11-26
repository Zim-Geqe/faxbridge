export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

export class FakeClock implements Clock {
  constructor(private t = new Date('2026-01-01T00:00:00.000Z')) {}
  now() {
    return new Date(this.t);
  }
  advance(ms: number) {
    this.t = new Date(this.t.getTime() + ms);
  }
}
