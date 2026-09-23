import assert from "node:assert/strict";
import test from "node:test";

import { parseCompleteAgentSettings, validateAgentAdmissionSettings } from "../cloudflare/agent-settings.mjs";

test("Cloudflare agent settings admit Claude subscription models only with supported options", () => {
  for (const model of ["claude-fable-5-1", "claude-opus-5-5"]) {
    const settings = { model, thinking: "high", reasoning_mode: "standard", fast_mode: false };
    assert.deepEqual(validateAgentAdmissionSettings(parseCompleteAgentSettings(settings)), settings);
    assert.throws(() => parseCompleteAgentSettings({ ...settings, thinking: "xhigh" }), /Claude/);
    assert.throws(() => parseCompleteAgentSettings({ ...settings, fast_mode: true }), /Claude/);
  }
});
