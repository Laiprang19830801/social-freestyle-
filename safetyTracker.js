class SafetyTracker {
  constructor() {
    this.logs = [];
  }
  log(event) {
    this.logs.push({ time: new Date(), event });
    console.log('[Safety]', event);
  }
}
module.exports = SafetyTracker;
